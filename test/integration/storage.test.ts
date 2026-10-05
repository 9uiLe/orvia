import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { CleanupReport, StorageStatus } from '../../src/application/storage.ts';
import type { Checkpoint } from '../../src/domain/checkpoint.ts';
import type { WorkItemId } from '../../src/domain/ids.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { StorageAssessment } from '../../src/domain/storage.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, rejectsWith, startPreparedRun, startTestDaemon } from '../helpers/app.ts';
import { config, makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository, snapshotRepository } from '../helpers/git.ts';
import { fillDurableData } from '../helpers/storage-fill.ts';

const KIB = 1024;
const MIB = 1024 * KIB;
const DAY_MS = 24 * 60 * 60 * 1000;

describe('bounded storage', () => {
  let env: TestEnv;
  let daemon: Daemon | null;

  beforeEach(() => {
    env = makeTestEnv();
    daemon = null;
  });
  afterEach(async () => {
    await daemon?.close();
    env.cleanup();
  });

  async function start(
    storage: Record<string, number> = {},
    agent = new FakeAgent(),
  ): Promise<Daemon> {
    daemon = await startTestDaemon(env, { config: config({ storage }), agent });
    return daemon;
  }

  function writeCacheFile(name: string, bytes: number, ageDays = 0): string {
    const path = join(env.paths.cacheDir, 'runs', name);
    mkdirSync(join(env.paths.cacheDir, 'runs'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 120));
    const time = new Date(Date.now() - ageDays * DAY_MS);
    utimesSync(path, time, time);
    return path;
  }

  function exists(path: string): boolean {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  }

  async function storage(d: Daemon): Promise<StorageStatus> {
    return call<StorageStatus>(d.app, 'get_storage_status');
  }

  async function boundWorkItem(d: Daemon): Promise<{ item: WorkItem; repo: string }> {
    const repo = createRepository(join(env.root, 'repo'));
    const worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(d.app, 'create_plan', { title: 'P' });
    const item = await call<WorkItem>(d.app, 'create_work_item', { planId: 'P-1', title: 'W' });
    await call(d.app, 'bind_workspace', { workItemId: item.id, worktreePath: worktree });
    return { item, repo };
  }

  async function runToEnd(d: Daemon, workItemId: WorkItemId): Promise<AgentRun> {
    const run = await startPreparedRun(d.app, {
      workItemId,
      profileId: 'fake',
      instructions: 'go',
    });
    await d.app.runs.waitForRun(run.id);
    return run;
  }

  test('data capacity leaves room for the rollback journal and a control reserve', async () => {
    const d = await start();
    const { assessment } = await storage(d);
    const { writeCapacityBytes, maxCapacityBytes, limitBytes } = assessment.database;
    assert.equal(limitBytes, 128 * MIB);
    assert.ok(writeCapacityBytes < maxCapacityBytes, 'control and maintenance have a reserve');
    // Main file at maxCapacity plus a journal of the same pages must still fit the budget.
    assert.ok(maxCapacityBytes * 2 < limitBytes);
    assert.ok(maxCapacityBytes * 2 > limitBytes * 0.99, 'no capacity is wasted beyond that');
  });

  test('quota approaching: levels rise through PRESSURE and WARNING to HARD_LIMIT', async () => {
    const d = await start({ cache_max_mb: 1 });
    const level = async () => (await d.app.storage.assess()).cache.level;
    assert.equal(await level(), 'NORMAL');
    writeCacheFile('a.log', Math.ceil(0.75 * MIB));
    assert.equal(await level(), 'PRESSURE');
    writeCacheFile('b.log', Math.ceil(0.2 * MIB));
    assert.equal(await level(), 'WARNING');
    writeCacheFile('c.log', Math.ceil(0.1 * MIB));
    assert.equal(await level(), 'HARD_LIMIT');
  });

  test('cleanup starts automatically after a write when storage is under pressure', async () => {
    const d = await start({ cache_max_mb: 1 });
    writeCacheFile('old.log', Math.ceil(0.8 * MIB));
    await call(d.app, 'create_plan', { title: 'trigger' });
    for (let i = 0; i < 200 && (await d.app.storage.assess()).cache.level !== 'NORMAL'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal((await d.app.storage.assess()).cache.level, 'NORMAL');
  });

  test('hard quota: new work is refused while status, controls, and maintenance still work', async () => {
    const d = await start({ database_max_mb: 5 });
    const { item } = await boundWorkItem(d);
    // Each refusal comes from the pre-write gate or from SQLite's page cap; neither writes.
    await fillDurableData(d.app);
    const full = await storage(d);
    assert.equal(full.assessment.database.level, 'HARD_LIMIT');
    assert.ok(full.assessment.database.usedBytes <= 5 * MIB);
    await rejectsWith(
      call(d.app, 'add_context', { planId: 'P-1', body: 'x' }),
      'STORAGE_HARD_LIMIT',
    );
    await rejectsWith(
      startPreparedRun(d.app, { workItemId: item.id, profileId: 'fake', instructions: 'go' }),
      'STORAGE_HARD_LIMIT',
    );
    await call(d.app, 'get_status');
    await call(d.app, 'get_storage_status');
    await call(d.app, 'pause_work_item', { workItemId: item.id });
    await call(d.app, 'resume_work_item', { workItemId: item.id });
    await call<CleanupReport>(d.app, 'run_storage_cleanup');
    await call(d.app, 'archive_work_item', { workItemId: item.id });
  });

  test('cache eviction removes the oldest entries until below the PRESSURE threshold', async () => {
    const d = await start({ cache_max_mb: 1 });
    const files = Array.from({ length: 10 }, (_, i) =>
      writeCacheFile(`f${i}.log`, 100 * KIB, (10 - i) / 1000),
    );
    const report = await call<CleanupReport>(d.app, 'run_storage_cleanup');
    assert.equal(report.before.cache.level, 'WARNING');
    assert.equal(report.after.cache.level, 'NORMAL');
    assert.ok(report.after.cache.usedBytes * 100 < MIB * 70);
    const kept = files.map(exists);
    assert.deepEqual(kept, [false, false, false, true, true, true, true, true, true, true]);
  });

  test('TTL: expired cache entries and migration backups are removed, fresh ones kept', async () => {
    const d = await start({ retention_days: 7 });
    const expired = writeCacheFile('expired.log', KIB, 8);
    const fresh = writeCacheFile('fresh.log', KIB, 1);
    const oldBackup = join(env.paths.backupDir, 'state-v0-old.db');
    writeFileSync(oldBackup, 'x');
    const backupTime = new Date(Date.now() - 8 * DAY_MS);
    utimesSync(oldBackup, backupTime, backupTime);

    const report = await call<CleanupReport>(d.app, 'run_storage_cleanup');
    assert.equal(exists(expired), false);
    assert.equal(exists(fresh), true);
    assert.deepEqual(report.backupsRemoved, [oldBackup]);
  });

  test('durable data is preserved while finished runs are pruned to the configured count', async () => {
    const agent = new FakeAgent();
    const d = await start({ max_completed_runs_per_work_item: 2 }, agent);
    const { item } = await boundWorkItem(d);
    const decision = await call<{ id: string }>(d.app, 'record_decision', {
      planId: 'P-1',
      title: 'Use X',
      body: 'because',
    });
    await call(d.app, 'add_context', { workItemId: item.id, body: 'context' });
    await call(d.app, 'submit_feedback', { workItemId: item.id, kind: 'redirect', body: 'turn' });
    const runs: AgentRun[] = [];
    for (let i = 0; i < 4; i++) runs.push(await runToEnd(d, item.id));

    await call<CleanupReport>(d.app, 'run_storage_cleanup');
    const plan = await call<{
      workItems: unknown[];
      decisions: { id: string }[];
      notes: unknown[];
    }>(d.app, 'get_plan', { planId: 'P-1' });
    assert.equal(plan.workItems.length, 1);
    assert.equal(plan.notes.length, 2);
    const details = await call<{ runs: AgentRun[]; checkpoints: Checkpoint[] }>(
      d.app,
      'get_work_item',
      {
        workItemId: item.id,
      },
    );
    assert.deepEqual(
      plan.decisions.map((entry) => entry.id).sort(),
      [
        decision.id,
        ...details.checkpoints.flatMap((checkpoint) =>
          checkpoint.reviews.map((review) => review.decisionId),
        ),
      ].sort(),
    );
    assert.deepEqual(
      details.runs.map((run) => run.id),
      [runs[3]?.id, runs[2]?.id],
    );
    const pruned = await rejectsWith(
      call(d.app, 'get_run_output', { runId: runs[0]?.id, maxBytes: 10 }),
      'NOT_FOUND',
    );
    assert.ok(pruned);
  });

  test('the output of a running agent is never evicted', async () => {
    const agent = new FakeAgent();
    const d = await start({ cache_max_mb: 1 }, agent);
    const { item } = await boundWorkItem(d);
    const release = join(env.root, 'release');
    agent.mode = `wait:${release}`;
    const run = await startPreparedRun(d.app, {
      workItemId: item.id,
      profileId: 'fake',
      instructions: 'go',
    });
    writeCacheFile('filler.log', Math.ceil(0.9 * MIB), 1);
    const outputPath = join(env.paths.cacheDir, run.outputRef ?? '');
    for (let i = 0; i < 200 && !exists(outputPath); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    utimesSync(outputPath, new Date(0), new Date(0));
    await call<CleanupReport>(d.app, 'run_storage_cleanup');
    assert.equal(exists(outputPath), true);
    writeFileSync(release, '');
    await d.app.runs.waitForRun(run.id);
  });

  test('agent output is truncated at the cache limit instead of growing past it', async () => {
    const agent = new FakeAgent();
    agent.mode = `bytes:${2 * MIB}`;
    const d = await start({ cache_max_mb: 1 }, agent);
    const { item } = await boundWorkItem(d);
    const run = await runToEnd(d, item.id);
    const { run: finished } = await call<{ run: AgentRun }>(d.app, 'get_run_output', {
      runId: run.id,
      maxBytes: 1,
    });
    assert.equal(finished.outputTruncated, true);
    assert.ok(finished.outputBytes <= MIB);
  });

  test('no rollback journal is left between transactions', async () => {
    const d = await start();
    await call(d.app, 'create_plan', { title: 'P' });
    for (let i = 0; i < 50; i++) {
      await call(d.app, 'add_context', { planId: 'P-1', body: 'y'.repeat(4 * KIB) });
    }
    const usage = (await storage(d)).usage.database;
    assert.equal(usage.journalBytes, 0);
    assert.equal(usage.walBytes, 0);
    assert.equal(usage.shmBytes, 0);
  });

  test('cleanup failure is reported and does not stop the remaining steps', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('root ignores directory permissions');
      return;
    }
    const d = await start({ retention_days: 1 });
    const stuck = writeCacheFile('stuck.log', KIB, 3);
    const runsDir = join(env.paths.cacheDir, 'runs');
    chmodSync(runsDir, 0o500);
    try {
      const report = await call<CleanupReport>(d.app, 'run_storage_cleanup');
      assert.ok(report.failures.some((failure) => failure.target === 'cache:runs/stuck.log'));
      assert.equal(typeof report.vacuumedPages, 'number', 'database maintenance still ran');
      assert.equal(exists(stuck), true);
    } finally {
      chmodSync(runsDir, 0o700);
    }
  });

  test('storage cleanup never changes a git repository or worktree', async () => {
    const d = await start({ cache_max_mb: 1, retention_days: 1 });
    const { item, repo } = await boundWorkItem(d);
    const worktree = item.workspace?.worktreeRoot ?? join(env.root, 'wt');
    writeFileSync(join(worktree, 'untracked.txt'), 'keep me');
    writeFileSync(join(repo, 'README.md'), 'modified, uncommitted\n');
    await runToEnd(d, item.id);
    writeCacheFile('expired.log', KIB, 5);
    writeCacheFile('big.log', Math.ceil(0.9 * MIB), 0);
    const repoBefore = snapshotRepository(repo);
    const worktreeBefore = snapshotRepository(worktree);

    for (let i = 0; i < 3; i++) await call<CleanupReport>(d.app, 'run_storage_cleanup');

    assert.equal(snapshotRepository(repo), repoBefore);
    assert.equal(snapshotRepository(worktree), worktreeBefore);
    assert.equal(readFileSync(join(worktree, 'untracked.txt'), 'utf8'), 'keep me');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'modified, uncommitted\n');
  });

  test('storage status exposes the assessment for every area', async () => {
    const d = await start();
    const status = await storage(d);
    const assessment: StorageAssessment = status.assessment;
    assert.equal(assessment.level, 'NORMAL');
    assert.ok(status.usage.database.mainBytes > 0);
  });
});
