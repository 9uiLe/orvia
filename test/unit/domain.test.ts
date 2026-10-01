import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatId, parseId } from '../../src/domain/ids.ts';
import { filesystemPolicyFor } from '../../src/domain/sandbox.ts';
import {
  assertOperationAllowed,
  assessStorage,
  type StorageLimits,
  type StorageUsage,
} from '../../src/domain/storage.ts';
import { transitionWorkItem, type WorkItem } from '../../src/domain/work-item.ts';
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
  test('allowed transitions', () => {
    assert.equal(transitionWorkItem(item('active'), 'pause'), 'paused');
    assert.equal(transitionWorkItem(item('paused'), 'resume'), 'active');
    assert.equal(transitionWorkItem(item('paused'), 'complete'), 'completed');
    assert.equal(transitionWorkItem(item('completed'), 'archive'), 'archived');
  });
  test('invalid transitions fail', () => {
    assert.throws(() => transitionWorkItem(item('paused'), 'pause'), {
      code: 'INVALID_STATE_TRANSITION',
    });
    assert.throws(() => transitionWorkItem(item('archived'), 'resume'), {
      code: 'INVALID_STATE_TRANSITION',
    });
  });
});

describe('storage pressure', () => {
  const MIB = 1024 * 1024;
  const limits: StorageLimits = {
    databaseMaxBytes: 100 * MIB,
    cacheMaxBytes: 100 * MIB,
    databaseReserveBytes: 4 * MIB,
    pressurePercent: 70,
    warningPercent: 90,
    retentionDays: 7,
    maxCompletedRunsPerWorkItem: 5,
  };
  const usage = (databaseMib: number, cacheMib = 0): StorageUsage => ({
    database: { mainBytes: databaseMib * MIB, walBytes: 0, shmBytes: 0, backupBytes: 0 },
    cacheBytes: cacheMib * MIB,
  });

  test('levels follow the configured thresholds and the reserve', () => {
    assert.equal(assessStorage(usage(69), limits).level, 'NORMAL');
    assert.equal(assessStorage(usage(70), limits).level, 'PRESSURE');
    assert.equal(assessStorage(usage(90), limits).level, 'WARNING');
    assert.equal(assessStorage(usage(96), limits).level, 'HARD_LIMIT');
    assert.equal(assessStorage(usage(95.9), limits).level, 'WARNING');
    assert.equal(assessStorage(usage(0, 100), limits).cache.level, 'HARD_LIMIT');
  });

  test('WAL, SHM, and backups count toward the database budget', () => {
    const assessment = assessStorage(
      {
        database: {
          mainBytes: 40 * MIB,
          walBytes: 20 * MIB,
          shmBytes: 1 * MIB,
          backupBytes: 40 * MIB,
        },
        cacheBytes: 0,
      },
      limits,
    );
    assert.equal(assessment.database.usedBytes, 101 * MIB);
    assert.equal(assessment.database.level, 'HARD_LIMIT');
  });

  test('at HARD_LIMIT only writes and agent runs are refused', () => {
    const databaseFull = assessStorage(usage(99), limits);
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

    const cacheFull = assessStorage(usage(1, 100), limits);
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
