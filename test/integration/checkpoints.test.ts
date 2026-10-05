import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RESULT_LIMITS } from '../../src/application/agent-results.ts';
import type { Checkpoint, WorkReport } from '../../src/domain/checkpoint.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import type { SqliteStore } from '../../src/infrastructure/sqlite/sqlite-store.ts';
import { call, FakeAgent, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, ManualClock, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository, git } from '../helpers/git.ts';

const REPORT: WorkReport = {
  status: 'completed',
  summary: 'Implemented the scoped change.',
  commands: [{ command: 'npm test', exitCode: 0, summary: 'Checks passed.' }],
  unresolved: '',
  requiredDecision: 'Review and choose the next step.',
};

describe('app-led checkpoints', () => {
  let env: TestEnv;
  let daemon: Daemon;
  let agent: FakeAgent;
  let item: WorkItem;
  let worktree: string;
  let clock: ManualClock;

  beforeEach(async () => {
    env = makeTestEnv();
    agent = new FakeAgent();
    agent.manualStep = { result: REPORT };
    clock = new ManualClock();
    daemon = await startTestDaemon(env, { agent, clock });
    const repo = createRepository(join(env.root, 'repo'));
    worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(daemon.app, 'create_plan', { title: 'Design in the app' });
    item = await call<WorkItem>(daemon.app, 'create_work_item', {
      planId: 'P-1',
      title: 'Scoped work',
    });
    await call(daemon.app, 'bind_workspace', { workItemId: item.id, worktreePath: worktree });
  });
  afterEach(async () => {
    await daemon.close();
    env.cleanup();
  });

  async function confirm(goal = 'Agreed goal') {
    return call(daemon.app, 'confirm_design', {
      planId: item.planId,
      goal,
      scope: 'This Work Item',
      constraints: '',
      acceptanceCriteria: 'Tests and human review',
    });
  }
  function prepare() {
    return call<Checkpoint>(daemon.app, 'prepare_prompt', {
      workItemId: item.id,
      profileId: 'fake',
      instructions: 'Implement the agreed scope',
      endCondition: 'Return the work report after verification',
    });
  }
  async function finish(checkpoint: Checkpoint) {
    const run = await call<AgentRun>(daemon.app, 'start_run', { checkpointId: checkpoint.id });
    await daemon.app.runs.waitForRun(run.id);
    return run;
  }
  function review(checkpoint: Checkpoint, action = 'continue') {
    return call<Checkpoint>(daemon.app, 'record_checkpoint_review', {
      checkpointId: checkpoint.id,
      evaluation: 'App evaluation: scoped change is sound',
      action,
      decision: 'Human choice: proceed with the next scoped task',
    });
  }

  test('preparation requires a confirmed design, preserves its revision, and never launches an agent', async () => {
    await rejectsWith(prepare(), 'DESIGN_NOT_CONFIRMED');
    await confirm();
    const checkpoint = await prepare();
    assert.equal(agent.invocations.length, 0);
    assert.equal(checkpoint.state, 'prepared');
    assert.equal(checkpoint.preparedContext.workspace.branch, 'feature');
    assert.equal(checkpoint.preparedContext.workspace.worktreeRoot, worktree);
    await confirm('Revised goal');
    const detail = await call<{ checkpoint: Checkpoint; design: { goal: string } }>(
      daemon.app,
      'get_checkpoint',
      { checkpointId: checkpoint.id },
    );
    assert.equal(detail.design.goal, 'Agreed goal');
    assert.equal(detail.checkpoint.prompt, checkpoint.prompt);
    await rejectsWith(
      call(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
      'PROMPT_STALE',
    );
    assert.equal(agent.invocations.length, 0);
  });

  test('concurrent sends launch once, send the stored text, and wait for evaluation and human judgment', async () => {
    await confirm();
    const checkpoint = await prepare();
    const runs = await Promise.all([
      call<AgentRun>(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
      call<AgentRun>(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
    ]);
    assert.equal(runs[0].id, runs[1].id);
    const run = runs[0];
    assert.ok(run);
    await daemon.app.runs.waitForRun(run.id);
    assert.equal(agent.invocations.length, 1);
    const invocation = agent.invocations[0];
    assert.ok(invocation);
    assert.equal(invocation.stdin, checkpoint.prompt);
    assert.equal(invocation.cwd, worktree);
    assert.deepEqual(
      (
        await call<{ checkpoint: Checkpoint }>(daemon.app, 'get_checkpoint', {
          checkpointId: checkpoint.id,
        })
      ).checkpoint.report,
      REPORT,
    );
    assert.equal(
      (await call<AgentRun>(daemon.app, 'start_run', { checkpointId: checkpoint.id })).id,
      run.id,
    );
    await rejectsWith(prepare(), 'HUMAN_REVIEW_REQUIRED');
    await call(daemon.app, 'record_decision', {
      planId: item.planId,
      workItemId: item.id,
      title: 'Unlinked decision',
      body: 'Continue',
    });
    await rejectsWith(prepare(), 'HUMAN_REVIEW_REQUIRED');
    await rejectsWith(
      call(daemon.app, 'complete_work_item', { workItemId: item.id }),
      'HUMAN_REVIEW_REQUIRED',
    );
    await review(checkpoint);
    const next = await prepare();
    assert.equal(next.previousCheckpointId, checkpoint.id);
    assert.match(next.prompt, /Implemented the scoped change/);
    assert.match(next.prompt, /App evaluation: scoped change is sound/);
    assert.match(next.prompt, /Human choice: proceed/);
    assert.equal(agent.invocations.length, 1);
    await finish(next);
    await review(next, 'complete');
    assert.equal(daemon.app.deps.store.workItems.get(item.id)?.status, 'completed');
  });

  for (const change of [
    'note',
    'decision',
    'tracked content',
    'untracked content',
    'index',
    'branch',
  ] as const) {
    test(`preparation becomes stale after a change to ${change}`, async () => {
      await confirm();
      const checkpoint = await prepare();
      if (change === 'note')
        await call(daemon.app, 'add_context', { workItemId: item.id, body: 'New context' });
      if (change === 'decision')
        await call(daemon.app, 'record_decision', {
          planId: item.planId,
          workItemId: item.id,
          title: 'New constraint',
          body: 'Changed judgment',
        });
      if (change === 'tracked content') writeFileSync(join(worktree, 'README.md'), '# changed\n');
      if (change === 'untracked content')
        writeFileSync(join(worktree, 'new.ts'), 'export const changed = true;');
      if (change === 'index') {
        writeFileSync(join(worktree, 'README.md'), '# index\n');
        git(worktree, 'add', 'README.md');
        writeFileSync(join(worktree, 'README.md'), '# fixture\n');
      }
      if (change === 'branch') git(worktree, 'switch', '-c', 'different');
      await rejectsWith(
        call(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
        change === 'branch' ? 'WORKSPACE_MISMATCH' : 'PROMPT_STALE',
      );
      assert.equal(agent.invocations.length, 0);
      assert.equal(daemon.app.deps.store.checkpoints.get(checkpoint.id)?.state, 'prepared');
    });
  }

  test('prepared prompts survive restart and profile changes require renewed preparation', async () => {
    await confirm();
    const checkpoint = await prepare();
    await daemon.close();
    daemon = await startTestDaemon(env, {
      agent,
      clock,
      profiles: { fake: { adapter: 'fake', capabilities: ['workspaceRead', 'structuredResult'] } },
    });
    await rejectsWith(
      call(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
      'PROMPT_STALE',
    );
    assert.equal(agent.invocations.length, 0);
    await daemon.close();
    daemon = await startTestDaemon(env, { agent, clock });
    await finish(checkpoint);
    assert.equal(agent.invocations[0]?.stdin, checkpoint.prompt);
  });

  for (const [name, step, expected] of [
    ['malformed', { stdout: '{broken' }, 'RESULT_PROTOCOL_INVALID'],
    ['missing', { stdout: '' }, 'RESULT_PROTOCOL_INVALID'],
    [
      'oversized field',
      { result: { ...REPORT, summary: 'x'.repeat(RESULT_LIMITS.summary + 1) } },
      'RESULT_PROTOCOL_INVALID',
    ],
    ['failed process', { result: REPORT, exitCode: 3 }, 'RUN_FAILED'],
  ] as const) {
    test(`${name} results remain explicit and require human review`, async () => {
      await confirm();
      const checkpoint = await prepare();
      agent.manualStep = step;
      await finish(checkpoint);
      const stored = daemon.app.deps.store.checkpoints.get(checkpoint.id);
      assert.ok(stored);
      assert.equal(stored.state, 'awaiting_review');
      assert.ok(stored.reportError?.startsWith(expected));
      if (name !== 'failed process') assert.equal(stored.report, null);
      await rejectsWith(prepare(), 'HUMAN_REVIEW_REQUIRED');
      assert.equal(daemon.app.deps.store.workItems.get(item.id)?.status, 'active');
    });
  }

  test('reports and next prompts survive log removal and run pruning without double launch', async () => {
    await confirm();
    const checkpoint = await prepare();
    const run = await finish(checkpoint);
    const available = await call<{ availability: string; truncated: boolean }>(
      daemon.app,
      'get_run_output',
      { runId: run.id, maxBytes: 1 },
    );
    assert.equal(available.availability, 'available');
    assert.equal(available.truncated, true);
    rmSync(env.paths.cacheDir, { recursive: true, force: true });
    assert.equal(
      (
        await call<{ availability: string }>(daemon.app, 'get_run_output', {
          runId: run.id,
          maxBytes: 1,
        })
      ).availability,
      'unavailable',
    );
    clock.advanceDays(31);
    assert.equal(
      (
        await call<{ availability: string }>(daemon.app, 'get_run_output', {
          runId: run.id,
          maxBytes: 1,
        })
      ).availability,
      'expired',
    );
    await review(checkpoint);
    const next = await prepare();
    daemon.app.deps.store.transaction(() => {
      daemon.app.deps.store.runs.delete(run.id);
    }, 'reserve');
    const detail = await call<{ checkpoint: Checkpoint; run: AgentRun | null }>(
      daemon.app,
      'get_checkpoint',
      { checkpointId: checkpoint.id },
    );
    assert.equal(detail.run, null);
    assert.deepEqual(detail.checkpoint.report, REPORT);
    await rejectsWith(
      call(daemon.app, 'start_run', { checkpointId: checkpoint.id }),
      'PROMPT_ALREADY_DISPATCHED',
    );
    await finish(next);
    assert.equal(agent.invocations.length, 2);
  });

  test('a crash after claiming a prompt recovers as interrupted without resending', async () => {
    await confirm();
    const checkpoint = await prepare();
    const run = daemon.app.deps.store.transaction(() => {
      const inserted = daemon.app.deps.store.runs.insert({
        workItemId: item.id,
        profileId: 'fake',
        purpose: 'manual',
        cycleId: null,
        outputRef: 'missing',
        now: clock.now().toISOString(),
      });
      daemon.app.deps.store.checkpoints.update(checkpoint.id, {
        state: 'running',
        runId: inserted.id,
        runStatus: 'running',
      });
      return inserted;
    });
    (daemon.app.deps.store as SqliteStore).close();
    daemon = await startTestDaemon(env, { agent, clock });
    const detail = await call<{ checkpoint: Checkpoint; recordingState: string }>(
      daemon.app,
      'get_checkpoint',
      { checkpointId: checkpoint.id },
    );
    assert.equal(detail.checkpoint.state, 'awaiting_review');
    assert.equal(detail.checkpoint.runStatus, 'interrupted');
    assert.equal(detail.checkpoint.reportError, 'RUN_INTERRUPTED_OR_REPORT_NOT_RECORDED');
    assert.equal(detail.recordingState, 'recorded');
    assert.equal(
      (await call<AgentRun>(daemon.app, 'start_run', { checkpointId: checkpoint.id })).id,
      run.id,
    );
    assert.equal(agent.invocations.length, 0);
    await rejectsWith(prepare(), 'HUMAN_REVIEW_REQUIRED');
  });
});
