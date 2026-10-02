import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatId, parseId } from '../../src/domain/ids.ts';
import { filesystemPolicyFor } from '../../src/domain/sandbox.ts';
import {
  assertOperationAllowed,
  assessStorage,
  databaseCapacity,
  JOURNAL_HEADER_BYTES,
  JOURNAL_RECORD_OVERHEAD_BYTES,
  type StorageLimits,
  type StorageUsage,
} from '../../src/domain/storage.ts';
import {
  assertWorkItemCanRun,
  transitionWorkItem,
  WORK_ITEM_STATUSES,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemTransition,
} from '../../src/domain/work-item.ts';
import { compareWorkspace, type WorkspaceIdentity } from '../../src/domain/workspace.ts';

const identity: WorkspaceIdentity = {
  repositoryCommonDir: '/r/.git',
  repositoryCommonDirFileId: '1:2:3',
  worktreeGitDir: '/r/.git/worktrees/a',
  worktreeGitDirFileId: '1:4:5',
  worktreeRoot: '/wt/a',
  branch: 'feature-a',
};

describe('ids', () => {
  test('round-trip and reject other kinds or malformed ids', () => {
    assert.equal(formatId('plan', 42), 'P-42');
    assert.equal(parseId('workItem', 'W-101'), 101);
    assert.throws(() => parseId('workItem', 'P-1'), { code: 'VALIDATION_FAILED' });
    assert.throws(() => parseId('plan', 'P-0'), { code: 'VALIDATION_FAILED' });
    assert.throws(() => parseId('plan', 'P-01'), { code: 'VALIDATION_FAILED' });
  });
});

describe('workspace comparison', () => {
  test('identical observation has no mismatch', () => {
    assert.deepEqual(compareWorkspace(identity, { ...identity }), []);
  });
  test('each changed attribute is reported', () => {
    assert.deepEqual(compareWorkspace(identity, null), ['worktree_missing']);
    assert.deepEqual(compareWorkspace(identity, { ...identity, branch: 'other' }), [
      'branch_changed',
    ]);
    assert.deepEqual(compareWorkspace(identity, { ...identity, branch: null }), ['detached_head']);
    assert.deepEqual(compareWorkspace(identity, { ...identity, worktreeGitDirFileId: '9:9:9' }), [
      'worktree_changed',
    ]);
    assert.deepEqual(
      compareWorkspace(identity, { ...identity, repositoryCommonDir: '/moved/.git' }),
      ['repository_changed'],
    );
  });
});

describe('filesystem policy', () => {
  test('working directory is the bound worktree root; git dirs are writable for commits', () => {
    const policy = filesystemPolicyFor(identity);
    assert.equal(policy.workingDirectory, '/wt/a');
    assert.deepEqual(policy.writableRoots, ['/wt/a', '/r/.git/worktrees/a', '/r/.git']);
  });
});

describe('work item transitions', () => {
  const item = (status: WorkItem['status']): WorkItem => ({
    id: 'W-1',
    planId: 'P-1',
    splitFromId: null,
    title: 't',
    description: '',
    status,
    branch: null,
    workspace: null,
    prUrl: null,
    createdAt: '',
    updatedAt: '',
  });
  const RESULT: Record<WorkItemStatus, Partial<Record<WorkItemTransition, WorkItemStatus>>> = {
    active: { pause: 'paused', complete: 'completed', archive: 'archived' },
    paused: { resume: 'active', complete: 'completed', archive: 'archived' },
    completed: { archive: 'archived' },
    archived: {},
  };
  const TRANSITIONS = ['pause', 'resume', 'complete', 'archive'] as const;

  for (const status of WORK_ITEM_STATUSES) {
    test(`a ${status} work item allows exactly ${Object.keys(RESULT[status]).join(', ') || 'nothing'}`, () => {
      for (const transition of TRANSITIONS) {
        const target = RESULT[status][transition];
        if (target === undefined) {
          assert.throws(() => transitionWorkItem(item(status), transition), {
            code: 'INVALID_STATE_TRANSITION',
          });
        } else {
          assert.equal(transitionWorkItem(item(status), transition), target);
        }
      }
    });
  }

  for (const status of WORK_ITEM_STATUSES) {
    test(`when the work item is ${status}, ${status === 'active' ? 'it can run' : 'running is refused'}`, () => {
      if (status === 'active') {
        assert.doesNotThrow(() => {
          assertWorkItemCanRun(item(status));
        });
      } else {
        assert.throws(
          () => {
            assertWorkItemCanRun(item(status));
          },
          { code: 'INVALID_STATE_TRANSITION' },
        );
      }
    });
  }
});

describe('database capacity', () => {
  const MIB = 1024 * 1024;
  const pageSize = 4096;

  test('main file at maxPages plus a full journal of those pages fits the budget', () => {
    for (const fixedBytes of [0, 10 * MIB, 60 * MIB]) {
      const capacity = databaseCapacity({
        budgetBytes: 128 * MIB,
        fixedBytes,
        pageSize,
        btreeCount: 16,
      });
      const worstCase =
        capacity.maxPages * pageSize +
        capacity.maxPages * (pageSize + JOURNAL_RECORD_OVERHEAD_BYTES) +
        JOURNAL_HEADER_BYTES +
        fixedBytes;
      assert.ok(worstCase <= 128 * MIB, `fixed ${fixedBytes}`);
      const onePageMore = worstCase + 2 * pageSize + JOURNAL_RECORD_OVERHEAD_BYTES;
      assert.ok(onePageMore > 128 * MIB, 'the cap is as large as the budget allows');
    }
  });

  test('backups and other files shrink the capacity; a full budget leaves none', () => {
    const base = databaseCapacity({
      budgetBytes: 128 * MIB,
      fixedBytes: 0,
      pageSize,
      btreeCount: 16,
    });
    const withBackup = databaseCapacity({
      budgetBytes: 128 * MIB,
      fixedBytes: 50 * MIB,
      pageSize,
      btreeCount: 16,
    });
    assert.ok(withBackup.maxPages < base.maxPages);
    assert.deepEqual(
      databaseCapacity({ budgetBytes: MIB, fixedBytes: 2 * MIB, pageSize, btreeCount: 16 }),
      { maxPages: 0, writeMaxPages: 0 },
    );
  });

  test('ordinary writes stop below the cap, leaving a reserve for control transactions', () => {
    const capacity = databaseCapacity({
      budgetBytes: 128 * MIB,
      fixedBytes: 0,
      pageSize,
      btreeCount: 16,
    });
    const depth = Math.ceil(Math.log2(capacity.maxPages));
    assert.equal(capacity.maxPages - capacity.writeMaxPages, 16 * (depth + 1) + 1);
  });
});

describe('storage pressure', () => {
  const MIB = 1024 * 1024;
  const limits: StorageLimits = {
    databaseMaxBytes: 100 * MIB,
    cacheMaxBytes: 100 * MIB,
    pressurePercent: 70,
    warningPercent: 90,
    retentionDays: 7,
    maxCompletedRunsPerWorkItem: 5,
  };
  const pageSize = 4096;
  const capacity = { maxPages: 12_000, writeMaxPages: 10_000 };
  const shape = (pages: number) => ({ pageSize, pageCount: pages, btreeCount: 16 });
  const usage = (cacheMib = 0, backupMib = 0): StorageUsage => ({
    database: {
      mainBytes: 0,
      walBytes: 0,
      shmBytes: 0,
      journalBytes: 0,
      backupBytes: backupMib * MIB,
    },
    cacheBytes: cacheMib * MIB,
  });
  const level = (pages: number) =>
    assessStorage(usage(), limits, shape(pages), capacity).database.level;

  test('database levels follow the data size against the write capacity', () => {
    assert.equal(level(6_999), 'NORMAL');
    assert.equal(level(7_000), 'PRESSURE');
    assert.equal(level(9_000), 'WARNING');
    assert.equal(level(10_000), 'HARD_LIMIT');
    assert.equal(assessStorage(usage(100), limits, shape(1), capacity).cache.level, 'HARD_LIMIT');
  });

  test('every budgeted file counts toward database usage', () => {
    const assessment = assessStorage(
      {
        database: {
          mainBytes: 40 * MIB,
          walBytes: 1 * MIB,
          shmBytes: 1 * MIB,
          journalBytes: 2 * MIB,
          backupBytes: 40 * MIB,
        },
        cacheBytes: 0,
      },
      limits,
      shape(1),
      capacity,
    );
    assert.equal(assessment.database.usedBytes, 84 * MIB);
  });

  test('at HARD_LIMIT only writes and agent runs are refused', () => {
    const databaseFull = assessStorage(usage(), limits, shape(10_000), capacity);
    for (const allowed of ['read', 'control', 'maintenance'] as const) {
      assertOperationAllowed(databaseFull, allowed);
    }
    assert.throws(
      () => {
        assertOperationAllowed(databaseFull, 'write');
      },
      {
        code: 'STORAGE_HARD_LIMIT',
      },
    );
    assert.throws(
      () => {
        assertOperationAllowed(databaseFull, 'agent_run');
      },
      {
        code: 'STORAGE_HARD_LIMIT',
      },
    );

    const cacheFull = assessStorage(usage(100), limits, shape(1), capacity);
    assertOperationAllowed(cacheFull, 'write');
    assert.throws(
      () => {
        assertOperationAllowed(cacheFull, 'agent_run');
      },
      {
        code: 'STORAGE_HARD_LIMIT',
      },
    );
  });
});
