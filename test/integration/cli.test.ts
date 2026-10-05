import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { DesignRevision, WorkReport } from '../../src/domain/checkpoint.ts';
import type { CheckpointView as Checkpoint } from '../../src/application/checkpoint-view.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { SourcePage, WorkspaceChanges } from '../../src/domain/repository-evidence.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { FakeAgent, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, writeConfig, type TestEnv } from '../helpers/env.ts';
import { createRepository } from '../helpers/git.ts';

const CLI = fileURLToPath(new URL('../../src/interface/cli/main.ts', import.meta.url));

describe('orvia CLI', () => {
  let env: TestEnv;
  let daemon: ChildProcess | null;

  beforeEach(() => {
    env = makeTestEnv();
    daemon = null;
  });
  afterEach(async () => {
    if (daemon !== null && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise((resolve) => daemon?.once('exit', resolve));
      daemon.kill('SIGTERM');
      await exited;
    }
    env.cleanup();
  });

  function orvia(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env.env },
    });
  }

  async function startDaemonProcess(): Promise<void> {
    daemon = spawn(process.execPath, [CLI, 'daemon'], {
      env: { ...process.env, ...env.env },
      stdio: 'ignore',
    });
    for (let i = 0; i < 300; i++) {
      if (orvia('status').status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('daemon did not start');
  }

  test('commands fail clearly when the daemon is not running', () => {
    const result = orvia('status');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DAEMON_NOT_RUNNING/);
  });

  test('JSON input must be an object before command flags are merged', () => {
    for (const input of ['null', '[]', '"text"', '{broken']) {
      const result = orvia('create-plan', '--input', input, '--title', 'From a flag');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /VALIDATION_FAILED/);
      assert.match(result.stderr, /JSON object/);
    }
  });

  test('doctor works without a daemon and does not create a database', () => {
    const result = orvia('doctor', '--json');
    assert.equal(result.status, 0, result.stderr);
    const checks = JSON.parse(result.stdout) as { name: string; status: string }[];
    assert.equal(checks.find((check) => check.name === 'daemon')?.status, 'warn');
    assert.equal(checks.find((check) => check.name === 'config')?.status, 'ok');
    assert.throws(() => readdirSync(env.paths.dataDir), { code: 'ENOENT' });
  });

  test('doctor reports an invalid configuration', () => {
    writeConfig(env, JSON.stringify({ storage: { cache_max_mb: -1 } }));
    const result = orvia('doctor', '--json');
    assert.equal(result.status, 1);
    const checks = JSON.parse(result.stdout) as { name: string; status: string }[];
    assert.equal(checks.find((check) => check.name === 'config')?.status, 'fail');
  });

  test('doctor and list-agent-profiles show each profile as the daemon sees it', async () => {
    writeConfig(
      env,
      JSON.stringify({
        agents: {
          profiles: {
            primary: { adapter: 'codex', command: process.execPath },
            ghost: { adapter: 'claude', command: '/nonexistent/agent' },
          },
        },
        orchestration: {
          default_implementation_profile: 'primary',
          default_review_profile: 'ghost',
        },
      }),
    );
    await startDaemonProcess();
    const listed = orvia('list-agent-profiles');
    assert.equal(listed.status, 0, listed.stderr);
    const { profiles } = JSON.parse(listed.stdout) as {
      profiles: { id: string; available: boolean }[];
    };
    assert.deepEqual(
      profiles.map((profile) => [profile.id, profile.available]),
      [
        ['primary', true],
        ['ghost', false],
      ],
    );

    const doctor = orvia('doctor', '--json');
    const checks = new Map(
      (JSON.parse(doctor.stdout) as { name: string; status: string; detail: string }[]).map(
        (check) => [check.name, check],
      ),
    );
    assert.equal(checks.get('agent profile primary')?.status, 'ok');
    assert.equal(checks.get('agent profile ghost')?.status, 'warn');
    assert.match(checks.get('agent profile ghost')?.detail ?? '', /NOT FOUND/);
    assert.equal(checks.get('default implementation profile')?.status, 'ok');
    assert.equal(checks.get('default review profile')?.status, 'warn');
  });

  test('CLI reports that legacy cycles are disabled by default', async () => {
    await startDaemonProcess();
    const profiles = orvia('list-agent-profiles');
    assert.equal(profiles.status, 0, profiles.stderr);
    assert.equal(
      (JSON.parse(profiles.stdout) as { legacyCyclesEnabled: boolean }).legacyCyclesEnabled,
      false,
    );
    const requests = [
      ['start-cycle', '--work-item-id', 'W-404', '--mode', 'implement', '--instructions', 'Change'],
      ['resume-cycle', '--cycle-id', 'C-404'],
    ];
    for (const request of requests) {
      const result = orvia(...request);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /LEGACY_CYCLES_DISABLED/);
    }
  });

  test('operations map to flags and print JSON', async () => {
    await startDaemonProcess();
    const created = orvia('create-plan', '--title', 'KMP rollout');
    assert.equal(created.status, 0, created.stderr);
    assert.equal((JSON.parse(created.stdout) as { id: string }).id, 'P-1');

    const repo = createRepository(join(env.root, 'repo'));
    assert.equal(orvia('create-work-item', '--plan-id', 'P-1', '--title', 'W').status, 0);
    const bound = orvia('bind-workspace', '--work-item-id', 'W-1', '--worktree-path', repo);
    assert.equal(bound.status, 0, bound.stderr);

    const list = orvia('work-items', '--statuses', 'active', '--statuses', 'paused');
    assert.equal((JSON.parse(list.stdout) as unknown[]).length, 1);

    assert.equal(orvia('create-plan', '--nope', 'x').status, 2);
  });
});

describe('checkpoint workflow through native CLI and IPC', () => {
  let env: TestEnv;
  let daemon: Daemon;
  let agent: FakeAgent;

  beforeEach(async () => {
    env = makeTestEnv();
    agent = new FakeAgent();
    daemon = await startTestDaemon(env, { agent, listen: true });
  });
  afterEach(async () => {
    writeFileSync(join(env.root, 'checkpoint-release'), '');
    await daemon.close();
    env.cleanup();
  });

  async function orvia<T>(...args: string[]): Promise<T> {
    const { stdout } = await promisify(execFile)(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env.env },
    });
    return JSON.parse(stdout) as T;
  }

  test('flags and JSON carry prepared prompts, source evidence, and explicit human completion', async () => {
    const repo = createRepository(join(env.root, 'repo'));
    const plan = await orvia<{ id: string }>('create-plan', '--title', 'CLI checkpoint workflow');
    const item = await orvia<WorkItem>(
      'create-work-item',
      '--plan-id',
      plan.id,
      '--title',
      'Change',
    );
    await orvia('bind-workspace', '--work-item-id', item.id, '--worktree-path', repo);
    const design = await orvia<DesignRevision>(
      'confirm-design',
      '--plan-id',
      plan.id,
      '--goal',
      'Deliver the agreed fixture change.',
      '--scope',
      'The bound repository.',
      '--constraints',
      'Preserve workspace identity.',
      '--acceptance-criteria',
      'The human can inspect the report and source before accepting.',
    );
    const instructions = 'Implement the agreed change and run the fixture check.';
    const endCondition = 'Stop after the check and return the work report.';
    const prepare = (instructions: string) =>
      orvia<Checkpoint>(
        'prepare-prompt',
        '--work-item-id',
        item.id,
        '--profile-id',
        'fake',
        '--instructions',
        instructions,
        '--end-condition',
        endCondition,
      );
    const prepared = await prepare(instructions);
    assert.equal(prepared.state, 'prepared');
    assert.equal(prepared.profileId, 'fake');
    assert.equal(prepared.designRevisionId, design.id);
    assert.equal(prepared.preparedContext.workspace.worktreeRoot, repo);
    for (const text of [instructions, endCondition, design.goal])
      assert.ok(prepared.prompt.includes(text));
    assert.equal(agent.invocations.length, 0);

    const report: WorkReport = {
      status: 'completed',
      summary: 'The fixture change is ready for human review.',
      commands: [{ command: 'fixture check', exitCode: 0, summary: 'agent-reported pass' }],
      unresolved: '',
      requiredDecision: '',
    };
    const release = join(env.root, 'checkpoint-release');
    agent.manualStep = { result: report, waitFor: release };
    const run = await orvia<AgentRun>('start-run', '--checkpoint-id', prepared.id);
    assert.equal(agent.invocations[0]?.stdin, prepared.prompt);
    const binary = Buffer.from([0, 255, 128]);
    writeFileSync(join(repo, 'new-source.ts'), 'export const answer = 42;\n');
    writeFileSync(join(repo, 'new-binary.bin'), binary);
    writeFileSync(release, '');
    await daemon.app.runs.waitForRun(run.id);
    const inspected = await orvia<{
      checkpoint: Checkpoint;
      run: AgentRun;
      verificationSource: string;
      changedFiles: string[];
    }>('get-checkpoint', '--checkpoint-id', prepared.id);
    assert.equal(inspected.checkpoint.state, 'awaiting_review');
    assert.equal(inspected.run.status, 'succeeded');
    assert.deepEqual(inspected.checkpoint.report, report);
    assert.equal(inspected.verificationSource, 'agent_reported');
    assert.deepEqual(inspected.changedFiles, ['new-binary.bin', 'new-source.ts']);
    const changes = await orvia<WorkspaceChanges & { matchesReport: boolean }>(
      'get-checkpoint-changes',
      '--checkpoint-id',
      prepared.id,
      '--max-bytes',
      '100000',
    );
    assert.equal(changes.complete, false, 'binary content requires source retrieval');
    assert.equal(changes.matchesReport, true);
    assert.match(changes.diff, /export const answer = 42/);
    const source = await orvia<SourcePage>(
      'get-checkpoint-source',
      '--input',
      JSON.stringify({
        checkpointId: prepared.id,
        path: 'new-binary.bin',
        offset: 0,
        maxBytes: 100_000,
        expectedFingerprint: changes.fingerprint,
      }),
    );
    assert.equal(source.encoding, 'base64');
    assert.equal(source.complete, true);
    assert.deepEqual(Buffer.from(source.content, 'base64'), binary);

    const evaluation = 'The app inspected the source and the agent-reported commands.';
    const decision = 'The human requests a final checkpoint to finish the agreed change.';
    const reviewed = await orvia<Checkpoint>(
      'record-checkpoint-review',
      '--checkpoint-id',
      prepared.id,
      '--evaluation',
      evaluation,
      '--action',
      'continue',
      '--decision',
      decision,
    );
    assert.equal(reviewed.state, 'reviewed');
    const next = await prepare('Finish the agreed change.');
    assert.equal(next.previousCheckpointId, prepared.id);
    for (const text of [report.summary, evaluation, decision])
      assert.ok(next.prompt.includes(text));
    assert.equal(agent.invocations.length, 1);
    agent.manualStep = { result: report };
    const nextRun = await orvia<AgentRun>('start-run', '--checkpoint-id', next.id);
    assert.equal(agent.invocations[1]?.stdin, next.prompt);
    await daemon.app.runs.waitForRun(nextRun.id);
    const secondReport = await orvia<{ checkpoint: Checkpoint }>(
      'get-checkpoint',
      '--checkpoint-id',
      next.id,
    );
    assert.equal(secondReport.checkpoint.state, 'awaiting_review');
    assert.deepEqual(secondReport.checkpoint.report, report);
    const accepted = await orvia<Checkpoint>(
      'record-checkpoint-review',
      '--input',
      JSON.stringify({
        checkpointId: next.id,
        evaluation: 'The app inspected the second report and accepts the finished scope.',
        action: 'complete',
        decision: 'The human accepts the result and completes this Work Item.',
      }),
    );
    assert.equal(accepted.reviews.at(-1)?.action, 'complete');
    const final = await orvia<{ workItem: WorkItem; checkpoints: Checkpoint[] }>(
      'get-work-item',
      '--work-item-id',
      item.id,
    );
    assert.equal(final.workItem.status, 'completed');
    assert.deepEqual(
      final.checkpoints.map((checkpoint) => checkpoint.id),
      [next.id, prepared.id],
    );
  });
});
