import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type {
  ProcessLauncher,
  Store,
  SyncResult,
  TransactionMode,
} from '../../src/application/ports.ts';
import type { Checkpoint, WorkReport } from '../../src/domain/checkpoint.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository } from '../helpers/git.ts';

interface CheckpointView {
  checkpoint: Checkpoint;
  run: AgentRun | null;
  recordingState: 'recorded' | 'pending' | 'incomplete';
}

const PREPARE = {
  workItemId: 'W-1',
  profileId: 'fake',
  instructions: 'Complete the scoped work and report',
  endCondition: 'Return the work report without starting another checkpoint',
};
const REPORT: WorkReport = {
  status: 'completed',
  summary: 'Agent-reported work completed',
  commands: [{ command: 'npm test', exitCode: 0, summary: 'passed' }],
  unresolved: '',
  requiredDecision: 'Review the result',
};

describe('checkpoint failure boundaries', () => {
  let env: TestEnv;
  let agent: FakeAgent;
  let daemon: Daemon | null;
  let release: string;

  beforeEach(() => {
    env = makeTestEnv();
    agent = new FakeAgent('fake', env.root);
    release = join(env.root, 'release');
    agent.manualStep = { result: REPORT, waitFor: release };
    daemon = null;
  });
  afterEach(async () => {
    writeFileSync(release, '');
    await daemon?.close();
    env.cleanup();
  });

  async function setup(
    launcher?: ProcessLauncher,
  ): Promise<{ running: Daemon; checkpoint: Checkpoint }> {
    const running = await startTestDaemon(env, {
      agent,
      ...(launcher === undefined ? {} : { launcher }),
    });
    daemon = running;
    const repo = createRepository(join(env.root, 'repo'));
    const worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
    await call(running.app, 'create_plan', { title: 'Plan' });
    await call(running.app, 'create_work_item', { planId: 'P-1', title: 'Work' });
    await call(running.app, 'bind_workspace', { workItemId: 'W-1', worktreePath: worktree });
    await call(running.app, 'confirm_design', {
      planId: 'P-1',
      goal: 'Exercise failure handling',
      scope: 'One checkpoint',
      constraints: 'Preserve the bound workspace',
      acceptanceCriteria: 'Failures remain inspectable and never restart work automatically',
    });
    const checkpoint = await call<Checkpoint>(running.app, 'prepare_prompt', PREPARE);
    return { running, checkpoint };
  }

  function failReportTransactions(
    running: Daemon,
    run: AgentRun,
    failReserve: boolean,
  ): TransactionMode[] {
    const store = running.store;
    const originalTransaction: Store['transaction'] = store.transaction.bind(store);
    const rejected: TransactionMode[] = [];
    store.transaction = function <T>(fn: () => SyncResult<T>, mode?: TransactionMode): T {
      const requestedMode = mode ?? 'write';
      if (
        store.runs.get(run.id)?.status === 'succeeded' &&
        (requestedMode === 'write' || failReserve)
      ) {
        rejected.push(requestedMode);
        throw new OrviaError('STORAGE_HARD_LIMIT', 'injected report storage exhaustion');
      }
      return originalTransaction(fn, mode);
    };
    return rejected;
  }

  test('synchronous launch failure consumes the checkpoint and retry returns the same failed run', async () => {
    let launches = 0;
    const launcher: ProcessLauncher = {
      resolveCommand: (command) => Promise.resolve(command),
      launch: () => {
        launches++;
        throw new Error('spawn exploded');
      },
    };
    const { running, checkpoint } = await setup(launcher);
    await assert.rejects(
      call(running.app, 'start_run', { checkpointId: checkpoint.id }),
      /spawn exploded/,
    );
    const view = await call<CheckpointView>(running.app, 'get_checkpoint', {
      checkpointId: checkpoint.id,
    });
    assert.equal(view.checkpoint.state, 'awaiting_review');
    assert.equal(view.checkpoint.runStatus, 'failed');
    assert.equal(view.checkpoint.report, null);
    assert.equal(view.checkpoint.reportError, 'RUN_FAILED');
    assert.equal(view.recordingState, 'recorded');
    assert.equal(view.run?.status, 'failed');
    const retry = await call<AgentRun>(running.app, 'start_run', { checkpointId: checkpoint.id });
    assert.equal(retry.id, view.run.id);
    assert.equal(retry.status, 'failed');
    assert.equal(launches, 1);
    assert.equal(agent.invocations.length, 1);
    assert.equal(running.store.runs.listForWorkItem('W-1').length, 1);
    await rejectsWith(call(running.app, 'prepare_prompt', PREPARE), 'HUMAN_REVIEW_REQUIRED');
  });

  test('ordinary report storage exhaustion records the failure in reserve and waits for a human', async () => {
    const { running, checkpoint } = await setup();
    const run = await call<AgentRun>(running.app, 'start_run', { checkpointId: checkpoint.id });
    const rejected = failReportTransactions(running, run, false);
    writeFileSync(release, '');
    await running.app.runs.waitForRun(run.id);
    const view = await call<CheckpointView>(running.app, 'get_checkpoint', {
      checkpointId: checkpoint.id,
    });
    assert.deepEqual(rejected, ['write']);
    assert.equal(view.run?.status, 'succeeded');
    assert.equal(view.checkpoint.state, 'awaiting_review');
    assert.equal(view.checkpoint.runStatus, 'succeeded');
    assert.equal(view.checkpoint.report, null);
    assert.equal(view.checkpoint.reportError, 'REPORT_STORAGE_EXHAUSTED');
    assert.equal(view.checkpoint.endCode, null);
    assert.deepEqual(view.checkpoint.reviews, []);
    assert.equal(view.recordingState, 'recorded');
    await rejectsWith(call(running.app, 'prepare_prompt', PREPARE), 'HUMAN_REVIEW_REQUIRED');
    assert.equal(agent.invocations.length, 1);
    assert.equal(running.store.workItems.get('W-1')?.status, 'active');
  });

  test('exhausted report and reserve writes expose incomplete recording and recover to human review after restart', async () => {
    const { running, checkpoint } = await setup();
    const run = await call<AgentRun>(running.app, 'start_run', { checkpointId: checkpoint.id });
    const rejected = failReportTransactions(running, run, true);
    writeFileSync(release, '');
    await running.app.runs.waitForRun(run.id);
    const incomplete = await call<CheckpointView>(running.app, 'get_checkpoint', {
      checkpointId: checkpoint.id,
    });
    assert.deepEqual(rejected, ['write', 'reserve']);
    assert.equal(incomplete.recordingState, 'incomplete');
    assert.equal(incomplete.run?.status, 'succeeded');
    assert.equal(incomplete.checkpoint.report, null);
    await rejectsWith(call(running.app, 'prepare_prompt', PREPARE), 'HUMAN_REVIEW_REQUIRED');
    await running.close();
    daemon = null;

    const restarted = await startTestDaemon(env, { agent });
    daemon = restarted;
    const recovered = await call<CheckpointView>(restarted.app, 'get_checkpoint', {
      checkpointId: checkpoint.id,
    });
    assert.equal(recovered.recordingState, 'recorded');
    assert.equal(recovered.checkpoint.state, 'awaiting_review');
    assert.equal(recovered.checkpoint.runStatus, 'succeeded');
    assert.equal(recovered.checkpoint.report, null);
    assert.equal(recovered.checkpoint.reportError, 'RUN_INTERRUPTED_OR_REPORT_NOT_RECORDED');
    assert.equal(recovered.checkpoint.prompt, checkpoint.prompt);
    assert.deepEqual(recovered.checkpoint.reviews, []);
    await rejectsWith(call(restarted.app, 'prepare_prompt', PREPARE), 'HUMAN_REVIEW_REQUIRED');
    assert.equal(agent.invocations.length, 1);
    assert.equal(restarted.store.runs.listForWorkItem('W-1').length, 1);
  });
});
