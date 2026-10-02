import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AgentRun } from '../../src/domain/records.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, rejectsWith, startTestDaemon, until } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository } from '../helpers/git.ts';

describe('agent runs', () => {
  let env: TestEnv;
  let agent: FakeAgent;
  let daemon: Daemon;
  let item: WorkItem;
  let release: string;

  beforeEach(async () => {
    env = makeTestEnv();
    agent = new FakeAgent();
    daemon = await startTestDaemon(env, { agent });
    const repo = createRepository(join(env.root, 'repo'));
    const worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(daemon.app, 'create_plan', { title: 'P' });
    item = await call<WorkItem>(daemon.app, 'create_work_item', { planId: 'P-1', title: 'W' });
    await call(daemon.app, 'bind_workspace', { workItemId: item.id, worktreePath: worktree });
    release = join(env.root, 'release');
  });

  afterEach(async () => {
    writeFileSync(release, '');
    await daemon.close();
    env.cleanup();
  });

  function start(): Promise<AgentRun> {
    return call<AgentRun>(daemon.app, 'start_run', {
      workItemId: item.id,
      agent: 'fake',
      instructions: 'go',
    });
  }

  async function runState(runId: string): Promise<AgentRun> {
    return (await call<{ run: AgentRun }>(daemon.app, 'get_run_output', { runId, maxBytes: 1 }))
      .run;
  }

  test('no write transaction is held while the agent runs', async () => {
    agent.mode = `wait:${release}`;
    const run = await start();
    assert.equal(run.status, 'running');
    // Every write opens BEGIN IMMEDIATE on the daemon's single connection; this would fail with
    // "cannot start a transaction within a transaction" if the run had left one open.
    await call(daemon.app, 'create_plan', { title: 'written while the agent runs' });
    await call(daemon.app, 'add_context', { workItemId: item.id, body: 'mid-run context' });
    assert.equal((await runState(run.id)).status, 'running');
    writeFileSync(release, '');
    await daemon.app.runs.waitForRun(run.id);
    assert.equal((await runState(run.id)).status, 'succeeded');
  });

  test('pausing a Work Item cancels its running agent and blocks new runs', async () => {
    agent.mode = `wait:${release}`;
    const run = await start();
    await call(daemon.app, 'pause_work_item', { workItemId: item.id });
    await daemon.app.runs.waitForRun(run.id);
    assert.equal((await runState(run.id)).status, 'cancelled');
    await rejectsWith(start(), 'INVALID_STATE_TRANSITION');
    await call(daemon.app, 'resume_work_item', { workItemId: item.id });
    agent.mode = 'echo';
    const next = await start();
    await daemon.app.runs.waitForRun(next.id);
    assert.equal((await runState(next.id)).status, 'succeeded');
  });

  test('only one run per Work Item at a time', async () => {
    agent.mode = `wait:${release}`;
    const run = await start();
    await rejectsWith(start(), 'RUN_IN_PROGRESS');
    await rejectsWith(
      call(daemon.app, 'complete_work_item', { workItemId: item.id }),
      'RUN_IN_PROGRESS',
    );
    writeFileSync(release, '');
    await daemon.app.runs.waitForRun(run.id);
  });

  test('a failing agent is recorded as failed with its exit code', async () => {
    agent.mode = 'fail';
    const run = await start();
    await daemon.app.runs.waitForRun(run.id);
    const state = await runState(run.id);
    assert.equal(state.status, 'failed');
    assert.equal(state.exitCode, 3);
  });

  test('runs left running by a stopped daemon are marked interrupted on restart', async () => {
    agent.mode = `wait:${release}`;
    const run = await start();
    await until(() => existsSync(join(env.paths.cacheDir, run.outputRef ?? '')));
    await daemon.close();
    daemon = await startTestDaemon(env, { agent });
    assert.equal((await runState(run.id)).status, 'interrupted');
    const status = await call<{ runningRuns: number }>(daemon.app, 'get_status');
    assert.equal(status.runningRuns, 0);
  });

  test('human decisions and feedback reach the next prompt; superseded decisions do not', async () => {
    const first = await call<{ id: string }>(daemon.app, 'record_decision', {
      planId: 'P-1',
      title: 'Use REST',
      body: 'simple',
    });
    await call(daemon.app, 'record_decision', {
      planId: 'P-1',
      title: 'Use gRPC',
      body: 'changed our mind',
      supersedesDecisionId: first.id,
    });
    await call(daemon.app, 'submit_feedback', {
      workItemId: item.id,
      kind: 'reject',
      body: 'do not touch the public API',
    });
    const run = await start();
    await daemon.app.runs.waitForRun(run.id);
    const prompt = agent.invocations.at(-1)?.stdin ?? '';
    assert.match(prompt, /Use gRPC/);
    assert.doesNotMatch(prompt, /Use REST/);
    assert.match(prompt, /\[reject\] do not touch the public API/);
  });

  test('an unknown agent is refused before anything is recorded', async () => {
    await rejectsWith(
      call(daemon.app, 'start_run', { workItemId: item.id, agent: 'nope', instructions: 'go' }),
      'AGENT_UNAVAILABLE',
    );
    const details = await call<{ runs: AgentRun[] }>(daemon.app, 'get_work_item', {
      workItemId: item.id,
    });
    assert.deepEqual(details.runs, []);
  });
});
