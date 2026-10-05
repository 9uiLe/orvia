import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { CheckpointPatch } from '../../src/application/ports.ts';
import type { Checkpoint, WorkReport } from '../../src/domain/checkpoint.ts';
import { databaseUsedBytes } from '../../src/domain/storage.ts';
import { measureDatabaseFiles } from '../../src/infrastructure/sqlite/database-files.ts';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import { SqliteStore } from '../../src/infrastructure/sqlite/sqlite-store.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { startStorageSampler } from '../helpers/storage-sampler.ts';

const MIB = 1024 * 1024;
const NOW = '2026-01-01T00:00:00.000Z';

describe('checkpoint durable records', () => {
  let env: TestEnv;
  let store: SqliteStore;

  function open(budgetBytes = 128 * MIB): SqliteStore {
    const { db } = openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations: MIGRATIONS,
      now: () => new Date(NOW),
      databaseMaxBytes: budgetBytes,
    });
    return new SqliteStore(db, MIGRATIONS, {
      budgetBytes,
      fixedBytes: () => {
        const usage = measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir);
        return usage.walBytes + usage.shmBytes + usage.journalBytes + usage.backupBytes;
      },
    });
  }

  beforeEach(() => {
    env = makeTestEnv();
    mkdirSync(env.paths.dataDir, { recursive: true });
    store = open();
    store.transaction(() => {
      store.plans.insert({ title: 'plan', description: 'not a design', now: NOW });
      store.workItems.insert({
        planId: 'P-1',
        splitFromId: null,
        title: 'work',
        description: '',
        branch: null,
        now: NOW,
      });
      store.designRevisions.insert({
        planId: 'P-1',
        goal: 'goal',
        scope: 'scope',
        constraints: 'constraints',
        acceptanceCriteria: 'acceptance',
        now: NOW,
      });
    });
  });
  afterEach(() => {
    store.close();
    env.cleanup();
  });

  function checkpointInput() {
    return {
      workItemId: 'W-1' as const,
      designRevisionId: 'S-1' as const,
      profileId: 'codex',
      instructions: 'implement scoped work',
      endCondition: 'report after checking',
      prompt: 'the exact reviewed prompt\nwith all context',
      preparedContext: {
        workspace: {
          repositoryCommonDir: '/repo/.git',
          repositoryCommonDirFileId: '1:1',
          worktreeGitDir: '/repo/.git',
          worktreeGitDirFileId: '1:1',
          worktreeRoot: '/repo',
          branch: 'work',
        },
        code: {
          head: 'base',
          fingerprint: 'initial',
          files: [{ path: 'a.ts', fingerprint: 'a1' }],
        },
        contextHash: 'context',
        profileHash: 'profile',
      },
      baseCommit: 'base',
      previousCheckpointId: null,
      now: NOW,
    };
  }

  test('designs get independent per-plan revisions and previously prepared inputs remain unchanged', () => {
    const input = checkpointInput();
    const first = store.transaction(() => store.checkpoints.insert(input));
    const revision = store.transaction(() =>
      store.designRevisions.insert({
        planId: 'P-1',
        goal: 'new goal',
        scope: 'new scope',
        constraints: '',
        acceptanceCriteria: 'new acceptance',
        now: NOW,
      }),
    );
    const other = store.transaction(() => {
      const plan = store.plans.insert({ title: 'other', description: '', now: NOW });
      return store.designRevisions.insert({
        planId: plan.id,
        goal: 'other',
        scope: '',
        constraints: '',
        acceptanceCriteria: '',
        now: NOW,
      });
    });
    assert.equal(revision.revision, 2);
    assert.equal(other.revision, 1);
    assert.deepEqual(
      store.designRevisions.listForPlan('P-1').map((record) => record.id),
      ['S-2', 'S-1'],
    );
    assert.equal(store.designRevisions.latest('P-1')?.id, 'S-2');
    assert.equal(store.designRevisions.get('S-1')?.goal, 'goal');

    input.prompt = 'changed caller input';
    const file = input.preparedContext.code.files[0];
    assert.ok(file !== undefined);
    file.fingerprint = 'changed file';
    input.preparedContext.workspace.branch = 'changed branch';
    const extraFields: CheckpointPatch &
      Partial<Pick<Checkpoint, 'prompt' | 'designRevisionId' | 'preparedContext'>> = {
      state: 'running',
      prompt: 'replacement',
      designRevisionId: revision.id,
      preparedContext: input.preparedContext,
    };
    const updated = store.transaction(() => store.checkpoints.update(first.id, extraFields));
    assert.equal(updated.prompt, first.prompt);
    assert.equal(updated.designRevisionId, 'S-1');
    assert.deepEqual(updated.preparedContext, first.preparedContext);
    assert.equal(updated.state, 'running');
    store.close();
    store = open();
    assert.deepEqual(store.checkpoints.get(first.id), updated);
    assert.equal(store.designRevisions.get('S-1')?.goal, 'goal');
  });

  test('checkpoint lookup distinguishes prepared, discarded, running, and dispatched records', () => {
    const first = store.transaction(() => store.checkpoints.insert(checkpointInput()));
    assert.equal(store.checkpoints.latestDispatched('W-1'), null);
    const run = store.transaction(() =>
      store.runs.insert({
        workItemId: 'W-1',
        profileId: 'codex',
        outputRef: 'run.log',
        purpose: 'manual',
        cycleId: null,
        now: NOW,
      }),
    );
    store.transaction(() =>
      store.checkpoints.update(first.id, { state: 'running', runId: run.id, runStatus: 'running' }),
    );
    const next = store.transaction(() =>
      store.checkpoints.insert({ ...checkpointInput(), previousCheckpointId: first.id }),
    );
    const discarded = store.transaction(() => store.checkpoints.insert(checkpointInput()));
    store.transaction(() => store.checkpoints.update(discarded.id, { state: 'discarded' }));
    assert.equal(store.checkpoints.latestDispatched('W-1')?.id, first.id);
    assert.deepEqual(
      store.checkpoints.listForWorkItem('W-1').map((record) => record.id),
      [discarded.id, next.id, first.id],
    );
    assert.equal(store.checkpoints.findByRun(run.id)?.id, first.id);
    assert.deepEqual(
      store.checkpoints.listRunning().map((record) => record.id),
      [first.id],
    );
    assert.equal(store.checkpoints.get(next.id)?.previousCheckpointId, first.id);
    assert.throws(() =>
      store.transaction(() => store.checkpoints.update(next.id, { runId: run.id })),
    );
    assert.equal(store.checkpoints.get(next.id)?.runId, null);
    store.transaction(() =>
      store.checkpoints.update(first.id, {
        state: 'awaiting_review',
        reportError: 'invalid report',
        finishedAt: NOW,
      }),
    );
    assert.deepEqual(store.checkpoints.listRunning(), []);
    store.transaction(() => store.checkpoints.update(first.id, { reportError: null }));
    assert.equal(store.checkpoints.get(first.id)?.reportError, null);
  });

  test('pruning Run metadata retains prompt, report, review, design, and checkpoint relationships after restart', () => {
    const first = store.transaction(() => store.checkpoints.insert(checkpointInput()));
    const run = store.transaction(() =>
      store.runs.insert({
        workItemId: 'W-1',
        profileId: 'codex',
        outputRef: 'run.log',
        purpose: 'manual',
        cycleId: null,
        now: NOW,
      }),
    );
    const report: WorkReport = {
      status: 'completed',
      summary: 'done',
      commands: [{ command: 'npm test', exitCode: 0, summary: 'passed' }],
      unresolved: '',
      requiredDecision: 'accept',
    };
    const decision = store.transaction(() =>
      store.decisions.insert({
        planId: 'P-1',
        workItemId: 'W-1',
        title: 'continue',
        body: 'accepted',
        supersedesId: null,
        now: NOW,
      }),
    );
    const reviewed = store.transaction(() => {
      store.runs.finish(run.id, {
        status: 'succeeded',
        exitCode: 0,
        outputBytes: 10,
        outputTruncated: false,
        now: NOW,
      });
      return store.checkpoints.update(first.id, {
        state: 'reviewed',
        runId: run.id,
        runStatus: 'succeeded',
        report,
        endCode: { head: 'new', fingerprint: 'end', files: [] },
        reviews: [
          { evaluation: 'accepted', decisionId: decision.id, action: 'continue', createdAt: NOW },
        ],
        finishedAt: NOW,
      });
    });
    const next = store.transaction(() =>
      store.checkpoints.insert({ ...checkpointInput(), previousCheckpointId: first.id }),
    );
    assert.deepEqual(
      store.runs.listFinishedBeyond(0).map((record) => record.runId),
      [run.id],
    );
    store.transaction(() => {
      store.runs.delete(run.id);
    }, 'reserve');
    store.close();
    store = open();
    assert.equal(store.runs.get(run.id), null);
    assert.deepEqual(store.checkpoints.get(first.id), { ...reviewed, runId: null });
    assert.equal(store.checkpoints.get(next.id)?.previousCheckpointId, first.id);
    assert.equal(store.checkpoints.latestDispatched('W-1')?.id, first.id);
    assert.equal(store.decisions.get(decision.id)?.body, 'accepted');
    assert.equal(store.designRevisions.get(first.designRevisionId)?.goal, 'goal');
  });

  test('oversized checkpoint insertion rolls back within the real database and journal budget', async () => {
    store.close();
    const budget = 5 * MIB;
    store = open(budget);
    const sampler = await startStorageSampler(env.paths.databaseFile, env.paths.backupDir);
    try {
      assert.throws(
        () =>
          store.transaction(() =>
            store.checkpoints.insert({ ...checkpointInput(), prompt: 'x'.repeat(6 * MIB) }),
          ),
        { code: 'STORAGE_HARD_LIMIT' },
      );
    } finally {
      const peak = await sampler.stop();
      assert.ok(peak.total <= budget, `peak ${peak.total}`);
    }
    assert.deepEqual(store.checkpoints.listForWorkItem('W-1'), []);
    assert.equal(store.designRevisions.get('S-1')?.goal, 'goal');
    const usage = measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir);
    assert.equal(usage.journalBytes, 0);
    assert.ok(databaseUsedBytes(usage) <= budget);
  });
});
