import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { RESULT_LIMITS } from '../../src/application/agent-results.ts';
import type { CycleDetails } from '../../src/application/cycles.ts';
import { runCacheRefs } from '../../src/application/storage.ts';
import type { OverallStatus } from '../../src/application/status.ts';
import type { ProcessLauncher } from '../../src/application/ports.ts';
import { requiredCapabilitiesFor, type AgentCapability } from '../../src/domain/agent-profile.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import type { Cycle, CycleState } from '../../src/domain/cycle.ts';
import type { Finding, Review } from '../../src/domain/review.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import {
  call,
  FakeAgent,
  rejectsWith,
  startTestDaemon,
  until,
  type FakeStep,
} from '../helpers/app.ts';
import { config, makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { fillDurableData } from '../helpers/storage-fill.ts';
import { addWorktree, createRepository } from '../helpers/git.ts';

const implemented: FakeStep = { result: { status: 'completed', summary: 'implemented' } };
const verified: FakeStep = {
  result: {
    status: 'passed',
    summary: 'all checks pass',
    commands: [{ command: 'npm test', exitCode: 0, summary: 'ok' }],
  },
};
const verificationFailed: FakeStep = {
  result: {
    status: 'failed',
    summary: 'tests fail',
    commands: [{ command: 'npm test', exitCode: 1, summary: '2 failing' }],
  },
};
const passed: FakeStep = { result: { verdict: 'pass', summary: 'looks right', findings: [] } };
const fixed: FakeStep = { result: { status: 'fixed', summary: 'fixed', disputedFindingIds: [] } };

function finding(category: string, title: string): Record<string, unknown> {
  return {
    category,
    title,
    detail: `${title} in detail`,
    evidence: [{ path: 'src/a.ts', line: 3, message: 'here' }],
    suggestedAction: null,
  };
}

function reviewWith(...findings: Record<string, unknown>[]): FakeStep {
  return { result: { verdict: 'findings', summary: 'problems found', findings } };
}

const PROFILES = {
  'primary-profile': { adapter: 'adapter-a' },
  'review-profile': { adapter: 'adapter-b' },
};

describe('orchestration cycles', () => {
  let env: TestEnv;
  let agent: FakeAgent;
  let reviewer: FakeAgent;
  let daemon: Daemon;
  let item: WorkItem;
  let worktree: string;
  let release: string;

  async function boot(
    storage: Record<string, number> = {},
    profiles: Record<string, { adapter: string; capabilities?: AgentCapability[] }> = PROFILES,
    orchestration: Record<string, unknown> = {},
    launcher?: ProcessLauncher,
  ): Promise<void> {
    daemon = await startTestDaemon(env, {
      ...(launcher === undefined ? {} : { launcher }),
      agent,
      agents: [reviewer],
      profiles,
      config: config({ storage, orchestration }),
    });
  }

  beforeEach(async () => {
    env = makeTestEnv();
    agent = new FakeAgent('adapter-a', env.root);
    reviewer = new FakeAgent('adapter-b', env.root);
    await boot();
    const repo = createRepository(join(env.root, 'repo'));
    worktree = addWorktree(repo, join(env.root, 'wt'), 'feature');
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

  function start(mode = 'implement', workItemId = item.id): Promise<Cycle> {
    return call<Cycle>(daemon.app, 'start_cycle', {
      workItemId,
      mode,
      instructions: 'Add a greeting endpoint.',
      implementationProfileId: 'primary-profile',
      reviewProfileId: 'review-profile',
    });
  }

  function details(cycleId: string): CycleDetails {
    return daemon.app.cycles.get({ cycleId: cycleId as Cycle['id'] });
  }

  /** Waits for the cycle to rest in `state` with no agent running for it. */
  async function settle(cycleId: string, state: CycleState): Promise<Cycle> {
    await until(() => {
      const { cycle, runs } = details(cycleId);
      return cycle.state === state && runs.every((run) => run.status !== 'running');
    });
    return details(cycleId).cycle;
  }

  const roles = (fake: FakeAgent) => fake.invocations.map((invocation) => invocation.role);

  function invocation(fake: FakeAgent, index: number): FakeAgent['invocations'][number] {
    const found = fake.invocations.at(index);
    assert.ok(found, `${fake.id} has no invocation ${String(index)}`);
    return found;
  }

  test('implement, verify, and an independent review end at HUMAN_REVIEW_READY', async () => {
    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = { review: [passed] };
    const cycle = await start();
    assert.equal(cycle.state, 'IMPLEMENTING');

    const done = await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.equal(done.reason, null);
    assert.notEqual(done.completedAt, null);
    assert.deepEqual(roles(agent), ['implementation', 'verification']);
    assert.deepEqual(roles(reviewer), ['review']);
    // Each stage is granted exactly its required capabilities.
    assert.deepEqual(invocation(reviewer, 0).granted, requiredCapabilitiesFor('REVIEWING'));
    assert.deepEqual(invocation(agent, 0).granted, requiredCapabilitiesFor('IMPLEMENTING'));
    assert.deepEqual(invocation(agent, 1).granted, requiredCapabilitiesFor('VERIFYING'));
    assert.match(invocation(reviewer, 0).stdin, /Do not rely on what the implementation/);
    assert.match(invocation(reviewer, 0).stdin, /Orvia rules \(highest precedence\)/);
    // Exploratory commands are not checks; one that fails must not fail the verification.
    assert.match(invocation(agent, 1).stdin, /List only checks: leave out commands you ran/);

    const { runs, latestReview } = details(cycle.id);
    assert.deepEqual(
      runs.map((run) => [run.purpose, run.status]),
      [
        ['review', 'succeeded'],
        ['verification', 'succeeded'],
        ['implementation', 'succeeded'],
      ],
    );
    assert.equal(latestReview?.verdict, 'pass');

    // The boundary is HUMAN_REVIEW_READY: the Work Item is still open for the human.
    const status = await call<OverallStatus>(daemon.app, 'get_status');
    assert.equal(status.openWorkItems[0]?.status, 'active');
    assert.equal(status.openWorkItems[0].cycle, null);
    await start('review_existing').then((next) => settle(next.id, 'BLOCKED'));
    await call(daemon.app, 'cancel_cycle', { cycleId: 'C-2' });
    await call(daemon.app, 'complete_work_item', { workItemId: item.id });
  });

  test('routine findings are fixed, verified, and reviewed again', async () => {
    agent.script = {
      implementation: [implemented],
      verification: [verified, verified],
      fix: [fixed],
    };
    reviewer.script = {
      review: [
        reviewWith(finding('correctness', 'Off by one'), finding('test', 'No test')),
        passed,
      ],
    };
    const cycle = await start();
    const done = await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.equal(done.iteration, 2);
    assert.equal(done.autoFixRounds, 1);
    assert.deepEqual(roles(agent), ['implementation', 'verification', 'fix', 'verification']);

    const fixPrompt = invocation(agent, 2).stdin;
    assert.match(fixPrompt, /"id": "F-1"/);
    assert.match(fixPrompt, /"id": "F-2"/);
    assert.match(fixPrompt, /Off by one/);

    const first = await call<{ review: Review; findings: Finding[] }>(daemon.app, 'get_review', {
      reviewId: 'Rv-1',
    });
    assert.deepEqual(
      first.findings.map((f) => [f.id, f.policyAction, f.policyReason]),
      [
        ['F-1', 'AUTO_FIX', 'ROUTINE_FIX'],
        ['F-2', 'AUTO_FIX', 'ROUTINE_FIX'],
      ],
    );
  });

  test('failed checks go to the fix agent, which sees only the failing commands', async () => {
    agent.script = {
      implementation: [implemented],
      verification: [verificationFailed, verified],
      fix: [fixed],
    };
    reviewer.script = { review: [passed] };
    const cycle = await start();
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
    const fixPrompt = invocation(agent, 2).stdin;
    assert.match(fixPrompt, /Fix the failing checks/);
    assert.match(fixPrompt, /2 failing/);
  });

  test('a design question escalates; the decision reaches the resumed review', async () => {
    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = {
      review: [
        reviewWith(finding('correctness', 'Typo'), finding('public_api', 'Renames an endpoint')),
        passed,
      ],
    };
    const cycle = await start();
    const waiting = await settle(cycle.id, 'NEEDS_HUMAN');
    assert.equal(waiting.reason, 'DECISION_REQUIRED');
    assert.equal(waiting.resumeStage, 'REVIEWING');
    assert.deepEqual(details(cycle.id).needsHumanFindingIds, ['F-2']);
    // A mixed review does not start a partial fix; nothing ran after the review.
    assert.deepEqual(roles(agent), ['implementation', 'verification']);

    const current = await call<{ review: Review; findings: Finding[] }>(
      daemon.app,
      'get_current_review',
      { cycleId: cycle.id },
    );
    assert.deepEqual(
      current.findings.map((f) => [f.id, f.category, f.policyAction]),
      [
        ['F-1', 'correctness', 'AUTO_FIX'],
        ['F-2', 'public_api', 'NEEDS_HUMAN'],
      ],
    );

    // While a cycle is open the Work Item is controlled through it.
    const status = await call<OverallStatus>(daemon.app, 'get_status');
    assert.deepEqual(status.openWorkItems[0]?.cycle, {
      id: cycle.id,
      state: 'NEEDS_HUMAN',
      reason: 'DECISION_REQUIRED',
      iteration: 1,
      currentRunId: waiting.currentRunId,
    });
    await rejectsWith(start(), 'CYCLE_ACTIVE');
    await rejectsWith(
      call(daemon.app, 'start_run', {
        workItemId: item.id,
        profileId: 'primary-profile',
        instructions: 'go',
      }),
      'CYCLE_ACTIVE',
    );
    await rejectsWith(
      call(daemon.app, 'complete_work_item', { workItemId: item.id }),
      'CYCLE_ACTIVE',
    );

    await call(daemon.app, 'record_decision', {
      workItemId: item.id,
      title: 'Keep the old endpoint name',
      body: 'Clients depend on it.',
    });
    await call(daemon.app, 'add_context', { workItemId: item.id, body: 'Release is on Friday.' });
    const resumed = await call<Cycle>(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    assert.equal(resumed.state, 'REVIEWING');
    const done = await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.equal(done.iteration, 2);
    const resumedPrompt = invocation(reviewer, 1).stdin;
    assert.match(resumedPrompt, /Keep the old endpoint name: Clients depend on it\./);
    assert.match(resumedPrompt, /Release is on Friday\./);
  });

  test('an unknown category goes to a human, never to the fix agent', async () => {
    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = { review: [reviewWith(finding('unknown', 'Unclear intent'))] };
    const cycle = await start();
    await settle(cycle.id, 'NEEDS_HUMAN');
    const { findings } = await call<{ findings: Finding[] }>(daemon.app, 'get_current_review', {
      cycleId: cycle.id,
    });
    assert.deepEqual(
      findings.map((f) => [f.category, f.policyAction]),
      [['unknown', 'NEEDS_HUMAN']],
    );
    assert.ok(!roles(agent).includes('fix'));
  });

  test('a reviewer that does not follow the protocol blocks the cycle', async () => {
    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = { review: [{ stdout: 'LGTM, no problems found.' }, passed] };
    const cycle = await start();
    const blocked = await settle(cycle.id, 'BLOCKED');
    assert.equal(blocked.reason, 'REVIEW_PROTOCOL_INVALID');
    assert.equal(blocked.resumeStage, 'REVIEWING');
    assert.equal(details(cycle.id).latestReview, null);
    await call(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.ok(!roles(agent).includes('fix'));
  });

  test('a verification pass with a failing command is a protocol error', async () => {
    agent.script = {
      verification: [
        {
          result: {
            status: 'passed',
            summary: 'fine',
            commands: [{ command: 'npm test', exitCode: 1, summary: 'failed' }],
          },
        },
      ],
    };
    const cycle = await start('review_existing');
    assert.equal(cycle.state, 'VERIFYING');
    assert.equal((await settle(cycle.id, 'BLOCKED')).reason, 'RESULT_PROTOCOL_INVALID');
    assert.deepEqual(roles(agent), ['verification']);
  });

  test('checks that cannot run block the cycle instead of passing it', async () => {
    agent.script = {
      verification: [{ result: { status: 'blocked', summary: 'no node here', commands: [] } }],
    };
    const cycle = await start('review_existing');
    await settle(cycle.id, 'BLOCKED');
    assert.deepEqual(roles(reviewer), []);
  });

  test('a failing agent process blocks the cycle', async () => {
    agent.script = { implementation: [{ exitCode: 2, stdout: '' }] };
    const cycle = await start();
    const blocked = await settle(cycle.id, 'BLOCKED');
    assert.equal(blocked.reason, 'RUN_FAILED');
    assert.equal(blocked.resumeStage, 'IMPLEMENTING');
  });

  test('a disputed fix goes to a human', async () => {
    agent.script = {
      implementation: [implemented],
      verification: [verified],
      fix: [{ result: { status: 'disputed', summary: 'not a bug', disputedFindingIds: ['F-1'] } }],
    };
    reviewer.script = { review: [reviewWith(finding('correctness', 'Maybe wrong'))] };
    const cycle = await start();
    const waiting = await settle(cycle.id, 'NEEDS_HUMAN');
    assert.equal(waiting.reason, 'FIX_DISPUTED');
    // The fix may have changed files before stopping, so the resumed cycle verifies first.
    assert.equal(waiting.resumeStage, 'VERIFYING');
  });

  test('the fix loop stops at the limit, and a human resume starts a new budget', async () => {
    const limit = 2;
    await daemon.close();
    await boot({}, PROFILES, { max_review_fix_cycles: limit });
    const routine = reviewWith(finding('correctness', 'Still wrong'));
    // The review after the last allowed fix still reports findings; the next one passes.
    agent.script = {
      implementation: [implemented],
      verification: Array.from({ length: limit + 1 }, () => verified),
      fix: Array.from({ length: limit }, () => fixed),
    };
    reviewer.script = { review: [...Array.from({ length: limit + 1 }, () => routine), passed] };
    const cycle = await start();
    const stopped = await settle(cycle.id, 'NEEDS_HUMAN');
    assert.equal(stopped.autoFixRounds, limit);
    assert.equal(roles(agent).filter((role) => role === 'fix').length, limit);
    assert.equal(roles(reviewer).length, limit + 1);

    const resumed = await call<Cycle>(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    assert.equal(resumed.autoFixRounds, 0);
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
  });

  test('pause_cycle stops the agent before reporting PAUSED; resume continues', async () => {
    agent.script = {
      implementation: [{ waitFor: release, ...implemented }, implemented],
      verification: [verified],
    };
    reviewer.script = { review: [passed] };
    const cycle = await start();
    const paused = await call<Cycle>(daemon.app, 'pause_cycle', { cycleId: cycle.id });
    assert.equal(paused.state, 'PAUSED');
    assert.equal(paused.resumeStage, 'IMPLEMENTING');
    assert.equal(details(cycle.id).runs[0]?.status, 'cancelled');
    assert.equal(daemon.app.runs.activeRunCount(), 0);
    await rejectsWith(
      call(daemon.app, 'pause_cycle', { cycleId: cycle.id }),
      'INVALID_STATE_TRANSITION',
    );

    await call(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.deepEqual(roles(agent), ['implementation', 'implementation', 'verification']);
  });

  test('pausing the Work Item pauses its running cycle', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    await call(daemon.app, 'pause_work_item', { workItemId: item.id });
    const paused = details(cycle.id).cycle;
    assert.equal(paused.state, 'PAUSED');
    assert.equal(paused.reason, 'PAUSED_BY_HUMAN');
    assert.equal(paused.resumeStage, 'IMPLEMENTING');
    await rejectsWith(
      call(daemon.app, 'resume_cycle', { cycleId: cycle.id }),
      'INVALID_STATE_TRANSITION',
    );
  });

  test('cancel_cycle stops the agent and frees the Work Item for a new cycle', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    const cancelled = await call<Cycle>(daemon.app, 'cancel_cycle', { cycleId: cycle.id });
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(cancelled.reason, 'CANCELLED_BY_HUMAN');
    assert.equal(daemon.app.runs.activeRunCount(), 0);
    await rejectsWith(
      call(daemon.app, 'resume_cycle', { cycleId: cycle.id }),
      'INVALID_STATE_TRANSITION',
    );
    agent.script = {
      verification: [{ result: { status: 'blocked', summary: 'x', commands: [] } }],
    };
    await settle((await start('review_existing')).id, 'BLOCKED');
  });

  test('a daemon restart blocks the cycle and starts nothing until a human resumes', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    await until(() => agent.invocations.length === 1);
    await daemon.close();

    agent = new FakeAgent('adapter-a', env.root);
    reviewer = new FakeAgent('adapter-b', env.root);
    await boot();
    const blocked = details(cycle.id).cycle;
    assert.equal(blocked.state, 'BLOCKED');
    assert.equal(blocked.reason, 'RUN_INTERRUPTED');
    assert.equal(blocked.resumeStage, 'IMPLEMENTING');
    assert.equal(details(cycle.id).runs[0]?.status, 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(agent.invocations.length, 0);

    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = { review: [passed] };
    await call(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
  });

  test('after a crash, recovery blocks the cycle and starts nothing', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    await until(() => agent.invocations.length === 1);
    await daemon.close();
    // What a killed daemon leaves behind: the run still running and the cycle still in its stage.
    const db = new DatabaseSync(env.paths.databaseFile);
    db.exec(`UPDATE cycles SET state = 'IMPLEMENTING', reason = NULL, resume_stage = NULL;
      UPDATE runs SET status = 'running', exit_code = NULL, finished_at = NULL;`);
    db.close();

    agent = new FakeAgent('adapter-a', env.root);
    reviewer = new FakeAgent('adapter-b', env.root);
    await boot();
    const blocked = details(cycle.id).cycle;
    assert.equal(blocked.state, 'BLOCKED');
    assert.equal(blocked.reason, 'RUN_INTERRUPTED');
    assert.equal(blocked.resumeStage, 'IMPLEMENTING');
    assert.equal(details(cycle.id).runs[0]?.status, 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(agent.invocations.length, 0);

    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = { review: [passed] };
    await call(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
  });

  test('cache cleanup keeps the result files of a running stage', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    const run = details(cycle.id).runs[0];
    assert.ok(run?.outputRef);
    const refs = runCacheRefs(run.outputRef);
    await until(() => existsSync(join(env.paths.cacheDir, refs.result)));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const ref of [refs.result, refs.schema]) {
      utimesSync(join(env.paths.cacheDir, ref), old, old);
    }
    await call(daemon.app, 'run_storage_cleanup');
    assert.ok(existsSync(join(env.paths.cacheDir, refs.result)));
    assert.ok(existsSync(join(env.paths.cacheDir, refs.schema)));

    agent.script = { verification: [{ waitFor: release, ...verified }] };
    writeFileSync(release, '');
    await until(() => details(cycle.id).cycle.state === 'VERIFYING');
    assert.equal(
      details(cycle.id).runs.find((stage) => stage.purpose === 'implementation')?.result,
      JSON.stringify(implemented.result),
    );
  });

  test('cycles of different Work Items run side by side without mixing', async () => {
    const repo2 = createRepository(join(env.root, 'repo2'));
    const worktree2 = addWorktree(repo2, join(env.root, 'wt2'), 'other');
    const second = await call<WorkItem>(daemon.app, 'create_work_item', {
      planId: 'P-1',
      title: 'W2',
    });
    await call(daemon.app, 'bind_workspace', { workItemId: second.id, worktreePath: worktree2 });
    agent.script = {
      implementation: [
        { waitFor: release, ...implemented },
        { waitFor: release, ...implemented },
      ],
      verification: [verified, verified],
    };
    reviewer.script = { review: [passed, passed] };
    const one = await start();
    const two = await start('implement', second.id);
    await rejectsWith(start(), 'CYCLE_ACTIVE');
    writeFileSync(release, '');
    await settle(one.id, 'HUMAN_REVIEW_READY');
    await settle(two.id, 'HUMAN_REVIEW_READY');
    const cwds = agent.invocations.map((invocation) => invocation.cwd);
    assert.ok(cwds.includes(worktree) && cwds.includes(worktree2));
    assert.ok(details(one.id).runs.every((run) => run.workItemId === item.id));
    assert.ok(details(two.id).runs.every((run) => run.workItemId === second.id));
  });

  test('at the cache hard limit the next stage does not start and the cycle blocks', async () => {
    await daemon.close();
    await boot({ cache_max_mb: 1 });
    agent.script = { implementation: [{ ...implemented, holdFor: release }] };
    const cycle = await start();
    const resultFile = () =>
      readdirSync(join(env.paths.cacheDir, 'runs')).find((name) => name.endsWith('.result'));
    await until(() => {
      const name = resultFile();
      return name !== undefined && statSync(join(env.paths.cacheDir, 'runs', name)).size > 0;
    });
    // Cleanup scheduled by start_cycle may still run; it cannot delete from this directory.
    const pinned = join(env.paths.cacheDir, 'pinned');
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(pinned, 'filler.log'), Buffer.alloc(1200 * 1024, 120));
    chmodSync(pinned, 0o500);
    try {
      writeFileSync(release, '');
      const blocked = await settle(cycle.id, 'BLOCKED');
      assert.equal(blocked.reason, 'STORAGE_HARD_LIMIT');
      assert.equal(blocked.resumeStage, 'VERIFYING');
      assert.deepEqual(roles(agent), ['implementation']);
      await rejectsWith(
        call(daemon.app, 'resume_cycle', { cycleId: cycle.id }),
        'STORAGE_HARD_LIMIT',
      );
      await call(daemon.app, 'get_cycle', { cycleId: cycle.id });
      await call(daemon.app, 'cancel_cycle', { cycleId: cycle.id });
    } finally {
      chmodSync(pinned, 0o700);
    }
  });

  test('a result that does not fit the database blocks the cycle without using the reserve', async () => {
    await daemon.close();
    await boot({ database_max_mb: 5 });
    const big = 'x'.repeat(RESULT_LIMITS.detail);
    agent.script = { implementation: [implemented], verification: [verified] };
    reviewer.script = {
      review: [
        {
          waitFor: release,
          result: {
            verdict: 'findings',
            summary: big,
            findings: Array.from({ length: RESULT_LIMITS.findings }, (_, i) => ({
              ...finding('correctness', `Finding ${String(i)}`),
              detail: big,
            })),
          },
        },
      ],
    };
    const cycle = await start();
    await until(() => roles(reviewer).length === 1);
    await fillDurableData(daemon.app);
    writeFileSync(release, '');
    const blocked = await settle(cycle.id, 'BLOCKED');
    assert.equal(blocked.reason, 'STORAGE_HARD_LIMIT');
    assert.equal(blocked.resumeStage, 'REVIEWING');
    assert.equal(details(cycle.id).latestReview, null);
    const storage = await call<{ assessment: { database: { usedBytes: number } } }>(
      daemon.app,
      'get_storage_status',
    );
    assert.ok(storage.assessment.database.usedBytes <= 5 * 1024 * 1024);
    await rejectsWith(
      call(daemon.app, 'resume_cycle', { cycleId: cycle.id }),
      'STORAGE_HARD_LIMIT',
    );
    await call(daemon.app, 'cancel_cycle', { cycleId: cycle.id });
  });

  /**
   * A launcher whose agents never exit on their own and cannot be terminated, so a cycle stage
   * stays running. `holdNextResolve` makes the next command lookup wait, to let something else
   * happen while a start is between its checks and its transaction.
   */
  function stuckLauncher() {
    const control = {
      release: (): void => undefined,
      held: false,
      holdNextResolve: null as Promise<void> | null,
    };
    const launcher: ProcessLauncher = {
      resolveCommand: async (command) => {
        const hold = control.holdNextResolve;
        control.holdNextResolve = null;
        if (hold !== null) {
          control.held = true;
          await hold;
        }
        return command;
      },
      launch: () => ({
        exited: new Promise((resolve) => {
          control.release = () => {
            resolve({ exitCode: 0, signal: null, spawnError: null, leftoverError: null });
          };
        }),
        terminate: () =>
          Promise.reject(new OrviaError('AGENT_TERMINATION_FAILED', 'simulated', {})),
      }),
    };
    return { control, launcher };
  }

  test('when an implementation needs input, the cycle waits for a human and resumes implementing', async () => {
    agent.script = {
      implementation: [
        { result: { status: 'needs_input', summary: 'which database?' } },
        implemented,
      ],
      verification: [verified],
    };
    reviewer.script = { review: [passed] };
    const cycle = await start();
    const waiting = await settle(cycle.id, 'NEEDS_HUMAN');
    assert.equal(waiting.reason, 'AGENT_NEEDS_INPUT');
    assert.equal(waiting.resumeStage, 'IMPLEMENTING');
    assert.equal(waiting.completedAt, null);

    const resumed = await call<Cycle>(daemon.app, 'resume_cycle', { cycleId: cycle.id });
    assert.equal(resumed.state, 'IMPLEMENTING');
    assert.equal(resumed.reason, null);
    assert.equal(resumed.resumeStage, null);
    await settle(cycle.id, 'HUMAN_REVIEW_READY');
    assert.deepEqual(roles(agent), ['implementation', 'implementation', 'verification']);
  });

  test('when a Work Item has a cycle waiting for a human, it cannot be archived', async () => {
    agent.script = { implementation: [{ result: { status: 'needs_input', summary: 'q' } }] };
    const cycle = await start();
    await settle(cycle.id, 'NEEDS_HUMAN');
    await rejectsWith(
      call(daemon.app, 'archive_work_item', { workItemId: item.id }),
      'CYCLE_ACTIVE',
    );
    assert.equal(
      (await call<{ workItem: WorkItem }>(daemon.app, 'get_work_item', { workItemId: item.id }))
        .workItem.status,
      'active',
    );
  });

  test('when a stage fails to start for an unmapped reason, the cycle blocks with START_FAILED and leaves no run running', async () => {
    agent.buildInvocation = () => {
      throw new Error('adapter exploded');
    };
    await assert.rejects(start(), /adapter exploded/);
    const { cycle, runs } = details('C-1');
    assert.equal(cycle.state, 'BLOCKED');
    assert.equal(cycle.reason, 'START_FAILED');
    assert.equal(cycle.resumeStage, 'IMPLEMENTING');
    assert.deepEqual(
      runs.map((run) => run.status),
      ['failed'],
    );
    const refs = runCacheRefs(runs[0]?.outputRef ?? '');
    assert.equal(existsSync(join(env.paths.cacheDir, refs.result)), false);
    assert.equal(existsSync(join(env.paths.cacheDir, refs.schema)), false);
  });

  for (const operation of ['pause_cycle', 'cancel_cycle'] as const) {
    test(`when the agent cannot be stopped, ${operation} fails and the cycle keeps its state`, async () => {
      const { control, launcher } = stuckLauncher();
      await daemon.close();
      await boot({}, PROFILES, {}, launcher);
      const cycle = await start();

      await rejectsWith(
        call(daemon.app, operation, { cycleId: cycle.id }),
        'AGENT_TERMINATION_FAILED',
      );
      const after = details(cycle.id);
      assert.equal(after.cycle.state, 'IMPLEMENTING');
      assert.equal(after.cycle.reason, null);
      assert.equal(after.runs[0]?.status, 'running');
      control.release();
    });
  }

  test('when a paused cycle is cancelled, it has no stage left to resume', async () => {
    agent.script = { implementation: [{ waitFor: release, ...implemented }] };
    const cycle = await start();
    const paused = await call<Cycle>(daemon.app, 'pause_cycle', { cycleId: cycle.id });
    assert.equal(paused.resumeStage, 'IMPLEMENTING');
    const cancelled = await call<Cycle>(daemon.app, 'cancel_cycle', { cycleId: cycle.id });
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal(cancelled.resumeStage, null);
    assert.notEqual(cancelled.completedAt, null);
  });

  test('when a cycle starts while a manual run is being prepared, the manual run is refused with CYCLE_ACTIVE', async () => {
    const { control, launcher } = stuckLauncher();
    await daemon.close();
    await boot({}, PROFILES, {}, launcher);
    let open: () => void = () => undefined;
    control.holdNextResolve = new Promise((resolve) => {
      open = resolve;
    });
    const manual = call(daemon.app, 'start_run', {
      workItemId: item.id,
      profileId: 'primary-profile',
      instructions: 'go',
    });
    const refused = rejectsWith(manual, 'CYCLE_ACTIVE');
    await until(() => control.held);

    await start();
    open();
    await refused;
    control.release();
  });
});
