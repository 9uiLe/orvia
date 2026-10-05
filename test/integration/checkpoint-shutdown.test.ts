import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { WorkReport } from '../../src/domain/checkpoint.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, startPreparedRun, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository } from '../helpers/git.ts';

test('daemon shutdown waits for a finished checkpoint report and retains it after restart', async () => {
  const env = makeTestEnv();
  const agent = new FakeAgent('fake', env.root);
  const report: WorkReport = {
    status: 'completed',
    summary: 'Scoped work finished',
    commands: [{ command: 'npm test', exitCode: 0, summary: 'passed' }],
    unresolved: '',
    requiredDecision: 'Review the result',
  };
  const agentRelease = join(env.root, 'agent-release');
  agent.manualStep = { result: report, waitFor: agentRelease };
  const snapshotEntered = Promise.withResolvers<undefined>();
  const snapshotRelease = Promise.withResolvers<undefined>();
  let daemon: Daemon | null = null;
  let closing: Promise<void> | null = null;
  try {
    const running = await startTestDaemon(env, { agent });
    daemon = running;
    const repo = createRepository(join(env.root, 'repo'));
    const worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(running.app, 'create_plan', { title: 'Plan' });
    const item = await call<WorkItem>(running.app, 'create_work_item', {
      planId: 'P-1',
      title: 'Work',
    });
    await call(running.app, 'bind_workspace', {
      workItemId: item.id,
      worktreePath: worktree,
    });
    const originalSnapshot = running.app.deps.git.snapshot.bind(running.app.deps.git);
    let delaySnapshot = false;
    running.app.deps.git.snapshot = async (root) => {
      const snapshot = await originalSnapshot(root);
      if (delaySnapshot) {
        snapshotEntered.resolve(undefined);
        await snapshotRelease.promise;
      }
      return snapshot;
    };
    const run = await startPreparedRun(running.app, {
      workItemId: item.id,
      profileId: 'fake',
      instructions: 'Complete scoped work and report',
    });
    const checkpoint = running.store.checkpoints.findByRun(run.id);
    assert.ok(checkpoint !== null);
    delaySnapshot = true;
    writeFileSync(agentRelease, '');
    await snapshotEntered.promise;
    assert.equal(running.store.runs.get(run.id)?.status, 'succeeded');
    assert.equal(running.app.runs.activeRunCount(), 0);
    let closed = false;
    closing = running.close().then(() => {
      closed = true;
    });
    await setImmediate();
    assert.equal(closed, false, 'shutdown waits while the final code snapshot is pending');
    assert.equal(running.store.checkpoints.get(checkpoint.id)?.state, 'running');
    snapshotRelease.resolve(undefined);
    await closing;
    daemon = null;
    closing = null;

    const restarted = await startTestDaemon(env, { agent });
    daemon = restarted;
    const saved = restarted.store.checkpoints.get(checkpoint.id);
    assert.equal(saved?.state, 'awaiting_review');
    assert.equal(saved.runStatus, 'succeeded');
    assert.deepEqual(saved.report, report);
    assert.equal(saved.reportError, null);
    assert.ok(saved.endCode !== null);
    assert.equal(saved.prompt, checkpoint.prompt);
  } finally {
    snapshotRelease.resolve(undefined);
    if (closing !== null) await closing;
    else await daemon?.close();
    env.cleanup();
  }
});
