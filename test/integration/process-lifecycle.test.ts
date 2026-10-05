import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AgentInvocation, Logger, ProcessLauncher } from '../../src/application/ports.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { config, makeTestEnv, silentLogger, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository } from '../helpers/git.ts';
import { NodeProcessLauncher } from '../../src/infrastructure/agents/process-launcher.ts';

// Process-group termination is guaranteed on macOS and Linux only.
const posix = process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function pidsIn(file: string, count: number): Promise<number[]> {
  for (let i = 0; i < 500; i++) {
    if (existsSync(file)) {
      const pids = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
      if (pids.length >= count) return pids;
    }
    await sleep(10);
  }
  throw new Error(`fewer than ${count} pids in ${file}`);
}

describe('agent process lifecycle', { skip: !posix && 'POSIX process groups only' }, () => {
  let env: TestEnv;
  let agent: FakeAgent;
  let daemon: Daemon | null;
  let item: WorkItem;
  let pidFile: string;

  async function start(
    options: { graceMs?: number; launcher?: ProcessLauncher; logger?: Logger } = {},
  ): Promise<Daemon> {
    daemon = await startTestDaemon(env, {
      agent,
      config: config({
        agents: { termination_grace_ms: options.graceMs ?? 10_000, kill_confirmation_ms: 5_000 },
      }),
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    return daemon;
  }

  async function setup(d: Daemon): Promise<void> {
    const repo = createRepository(join(env.root, 'repo'));
    const worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(d.app, 'create_plan', { title: 'P' });
    item = await call<WorkItem>(d.app, 'create_work_item', { planId: 'P-1', title: 'W' });
    await call(d.app, 'bind_workspace', { workItemId: item.id, worktreePath: worktree });
  }

  function runAgent(d: Daemon): Promise<AgentRun> {
    return call<AgentRun>(d.app, 'start_run', {
      workItemId: item.id,
      profileId: 'fake',
      instructions: 'go',
    });
  }

  async function state(d: Daemon, runId: string) {
    const details = await call<{ workItem: WorkItem; runs: AgentRun[] }>(d.app, 'get_work_item', {
      workItemId: item.id,
    });
    return {
      workItem: details.workItem.status,
      run: details.runs.find((run) => run.id === runId)?.status,
    };
  }

  beforeEach(() => {
    env = makeTestEnv();
    agent = new FakeAgent();
    daemon = null;
    pidFile = join(env.root, 'pids');
  });

  afterEach(async () => {
    await daemon?.close();
    if (existsSync(pidFile)) {
      for (const pid of readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)) {
        if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
    env.cleanup();
  });

  test('pause returns after the agent and its descendants have exited', async () => {
    const d = await start();
    await setup(d);
    agent.mode = `tree:${pidFile}`;
    const run = await runAgent(d);
    const pids = await pidsIn(pidFile, 3);
    assert.ok(pids.every(alive), 'agent, child, and grandchild are running');

    const paused = await call<WorkItem>(d.app, 'pause_work_item', { workItemId: item.id });
    assert.equal(paused.status, 'paused');
    assert.deepEqual(pids.map(alive), [false, false, false]);
    assert.deepEqual(await state(d, run.id), { workItem: 'paused', run: 'cancelled' });
  });

  test('processes that ignore SIGTERM are killed after the grace period', async () => {
    const graceMs = 300;
    const d = await start({ graceMs });
    await setup(d);
    agent.mode = `stubborn-tree:${pidFile}`;
    const run = await runAgent(d);
    const pids = await pidsIn(pidFile, 3);

    const started = Date.now();
    await call(d.app, 'pause_work_item', { workItemId: item.id });
    assert.ok(Date.now() - started >= graceMs, 'SIGKILL waited for the grace period');
    assert.deepEqual(pids.map(alive), [false, false, false]);
    assert.deepEqual(await state(d, run.id), { workItem: 'paused', run: 'cancelled' });
  });

  test('processes an agent leaves behind are stopped when the agent exits', async () => {
    const d = await start();
    await setup(d);
    agent.mode = `leave-child:${pidFile}`;
    const run = await runAgent(d);
    const [child = 0] = await pidsIn(pidFile, 1);
    await d.app.runs.waitForRun(run.id);
    assert.equal(alive(child), false);
    assert.equal((await state(d, run.id)).run, 'succeeded');
  });

  test('if termination fails, the Work Item is not paused and the error is explicit', async () => {
    let release = (): void => undefined;
    const unkillable: ProcessLauncher = {
      resolveCommand: (command) => Promise.resolve(command),
      launch: () => ({
        exited: new Promise((resolve) => {
          release = () => {
            resolve({ exitCode: 0, signal: null, spawnError: null, leftoverError: null });
          };
        }),
        terminate: () =>
          Promise.reject(new OrviaError('AGENT_TERMINATION_FAILED', 'simulated', {})),
      }),
    };
    const d = await start({ launcher: unkillable });
    await setup(d);
    const run = await runAgent(d);

    await rejectsWith(
      call(d.app, 'pause_work_item', { workItemId: item.id }),
      'AGENT_TERMINATION_FAILED',
    );
    assert.deepEqual(await state(d, run.id), { workItem: 'active', run: 'running' });
    release();
    await d.app.runs.waitForRun(run.id);
  });

  test('a new run cannot start while a pause is stopping the previous one', async () => {
    const d = await start({ graceMs: 300 });
    await setup(d);
    agent.mode = `stubborn-tree:${pidFile}`;
    await runAgent(d);
    await pidsIn(pidFile, 3);
    const pausing = call(d.app, 'pause_work_item', { workItemId: item.id });
    await rejectsWith(runAgent(d), 'INVALID_STATE_TRANSITION');
    await pausing;
  });

  test('daemon shutdown stops agent process trees before recording their runs', async () => {
    const d = await start();
    await setup(d);
    agent.mode = `tree:${pidFile}`;
    const run = await runAgent(d);
    const pids = await pidsIn(pidFile, 3);

    await d.close();
    daemon = null;
    assert.deepEqual(pids.map(alive), [false, false, false]);

    const warnings: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (message: string) => {
        warnings.push(message);
      },
    };
    const restarted = await start({ logger });
    assert.deepEqual(
      warnings.filter((message) => message.includes('previous daemon')),
      [],
      'shutdown recorded the final state itself; startup recovery had nothing to do',
    );
    assert.equal((await state(restarted, run.id)).run, 'interrupted');
  });

  test('when launching the agent throws, the run is failed and the Work Item can run again', async () => {
    let failLaunch = true;
    const launcher: ProcessLauncher = {
      resolveCommand: (command) => Promise.resolve(command),
      launch: () => {
        if (failLaunch) throw new Error('spawn exploded');
        return {
          exited: Promise.resolve({
            exitCode: 0,
            signal: null,
            spawnError: null,
            leftoverError: null,
          }),
          terminate: () => Promise.resolve(),
        };
      },
    };
    const d = await start({ launcher });
    await setup(d);

    await assert.rejects(runAgent(d), /spawn exploded/);
    const { runs } = await call<{ runs: AgentRun[] }>(d.app, 'get_work_item', {
      workItemId: item.id,
    });
    assert.deepEqual(
      runs.map((run) => run.status),
      ['failed'],
    );
    assert.equal(d.app.runs.activeRunCount(), 0);
    await call(d.app, 'pause_work_item', { workItemId: item.id });
    await call(d.app, 'resume_work_item', { workItemId: item.id });

    failLaunch = false;
    const next = await runAgent(d);
    await d.app.runs.waitForRun(next.id);
    assert.equal((await state(d, next.id)).run, 'succeeded');
  });

  test('when the process group cannot be confirmed gone, termination escalates to SIGKILL and fails', async () => {
    const calls: [number, NodeJS.Signals | 0][] = [];
    const policy = { graceMs: 60, killConfirmationMs: 60 };
    const launcher = new NodeProcessLauncher(policy, (target, signal) => {
      calls.push([target, signal]);
    });
    const invocation: AgentInvocation = {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd: env.root,
      stdin: '',
    };
    const running = launcher.launch(invocation, () => undefined);
    const started = Date.now();
    try {
      await rejectsWith(running.terminate(), 'AGENT_TERMINATION_FAILED');
      assert.ok(
        Date.now() - started >= policy.graceMs + policy.killConfirmationMs,
        'waited for the grace period and then for kill confirmation',
      );
      const signals = calls.map(([, signal]) => signal).filter((signal) => signal !== 0);
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    } finally {
      // The stub never signalled the real process; stop it so the test leaves nothing behind.
      const target = calls[0]?.[0];
      if (target !== undefined) process.kill(target, 'SIGKILL');
    }
    const exit = await running.exited;
    assert.notEqual(exit.leftoverError, null, 'the run reports the processes it could not stop');
  });
});
