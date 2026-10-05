import assert from 'node:assert/strict';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { WorkItemId } from '../../src/domain/ids.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, FakeAgent, rejectsWith, startPreparedRun, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { addWorktree, createRepository, git } from '../helpers/git.ts';

describe('workspace identity safety', () => {
  let env: TestEnv;
  let daemon: Daemon;
  let agent: FakeAgent;
  let repo: string;

  beforeEach(async () => {
    env = makeTestEnv();
    agent = new FakeAgent();
    daemon = await startTestDaemon(env, { agent });
    repo = createRepository(join(env.root, 'repo'));
    await call(daemon.app, 'create_plan', { title: 'P' });
  });

  afterEach(async () => {
    await daemon.close();
    env.cleanup();
  });

  async function boundWorkItem(path: string, branch?: string): Promise<WorkItem> {
    const item = await call<WorkItem>(daemon.app, 'create_work_item', {
      planId: 'P-1',
      title: 'work',
      ...(branch === undefined ? {} : { branch }),
    });
    return call<WorkItem>(daemon.app, 'bind_workspace', {
      workItemId: item.id,
      worktreePath: path,
    });
  }

  async function startRun(workItemId: WorkItemId): Promise<AgentRun> {
    return startPreparedRun(daemon.app, {
      workItemId,
      profileId: 'fake',
      instructions: 'do it',
    });
  }

  async function assertRefused(workItemId: WorkItemId, reason: string): Promise<void> {
    const error = await rejectsWith(startRun(workItemId), 'WORKSPACE_MISMATCH');
    assert.ok((error.details['reasons'] as string[]).includes(reason), error.message);
    assert.equal(agent.invocations.length, 0, 'no agent may start after a mismatch');
    const item = await call<{ runs: AgentRun[] }>(daemon.app, 'get_work_item', { workItemId });
    assert.deepEqual(item.runs, [], 'a refused run leaves no run record');
  }

  test('correct worktree: the agent runs in the bound worktree root', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const item = await boundWorkItem(worktree, 'feature-a');
    assert.equal(item.workspace?.worktreeRoot, worktree);
    assert.equal(item.workspace.branch, 'feature-a');

    const run = await startRun(item.id);
    await daemon.app.runs.waitForRun(run.id);
    assert.equal(agent.invocations.length, 1);
    assert.equal(agent.invocations[0]?.cwd, worktree);
    const finished = await call<{ run: AgentRun; output: string }>(daemon.app, 'get_run_output', {
      runId: run.id,
      maxBytes: 100_000,
    });
    assert.equal(finished.run.status, 'succeeded');
    assert.equal((JSON.parse(finished.output) as { cwd: string }).cwd, worktree);
  });

  test('binding from a subdirectory records the worktree root', async () => {
    mkdirSync(join(repo, 'nested', 'dir'), { recursive: true });
    const item = await boundWorkItem(join(repo, 'nested', 'dir'));
    assert.equal(item.workspace?.worktreeRoot, repo);
    assert.equal(item.branch, 'main');
  });

  test('wrong worktree: binding a worktree on another branch is refused', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-b'), 'feature-b');
    await rejectsWith(boundWorkItem(worktree, 'feature-a'), 'WORKSPACE_MISMATCH');
  });

  test('wrong worktree: another worktree now occupies the bound path', async () => {
    const path = join(env.root, 'wt-a');
    addWorktree(repo, path, 'feature-a');
    const item = await boundWorkItem(path, 'feature-a');
    git(repo, 'worktree', 'remove', path);
    addWorktree(repo, path, 'feature-other');
    await assertRefused(item.id, 'branch_changed');
  });

  test('branch changed inside the worktree', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const item = await boundWorkItem(worktree, 'feature-a');
    git(worktree, 'checkout', '--quiet', '-b', 'surprise');
    await assertRefused(item.id, 'branch_changed');
  });

  test('detached HEAD is refused', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const item = await boundWorkItem(worktree, 'feature-a');
    git(worktree, 'checkout', '--quiet', '--detach');
    await assertRefused(item.id, 'detached_head');
  });

  test('worktree removed', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const item = await boundWorkItem(worktree, 'feature-a');
    git(repo, 'worktree', 'remove', worktree);
    await assertRefused(item.id, 'worktree_missing');
  });

  test('worktree recreated at the same path on the same branch', async () => {
    const path = join(env.root, 'wt-a');
    addWorktree(repo, path, 'feature-a');
    const item = await boundWorkItem(path, 'feature-a');
    git(repo, 'worktree', 'remove', path);
    git(repo, 'worktree', 'add', '--quiet', path, 'feature-a');
    await assertRefused(item.id, 'worktree_changed');
  });

  test('repository moved', async () => {
    const item = await boundWorkItem(repo, 'main');
    renameSync(repo, `${repo}-moved`);
    await assertRefused(item.id, 'worktree_missing');
  });

  test('repository replaced by a different repository at the same path', async () => {
    const item = await boundWorkItem(repo, 'main');
    rmSync(repo, { recursive: true, force: true });
    createRepository(repo);
    await assertRefused(item.id, 'repository_changed');
  });

  test('multiple worktrees: each Work Item runs in its own worktree', async () => {
    const a = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const b = addWorktree(repo, join(env.root, 'wt-b'), 'feature-b');
    const itemA = await boundWorkItem(a, 'feature-a');
    const itemB = await boundWorkItem(b, 'feature-b');

    const runB = await startRun(itemB.id);
    const runA = await startRun(itemA.id);
    await Promise.all([daemon.app.runs.waitForRun(runA.id), daemon.app.runs.waitForRun(runB.id)]);
    assert.deepEqual(agent.invocations.map((invocation) => invocation.cwd).sort(), [a, b].sort());

    const discovered = await call<{ path: string; branch: string; boundWorkItemIds: string[] }[]>(
      daemon.app,
      'discover_worktrees',
      { repositoryPath: repo },
    );
    const byPath = new Map(discovered.map((entry) => [entry.path, entry]));
    assert.deepEqual(byPath.get(a)?.boundWorkItemIds, [itemA.id]);
    assert.deepEqual(byPath.get(b)?.boundWorkItemIds, [itemB.id]);
    assert.deepEqual(byPath.get(repo)?.boundWorkItemIds, []);
  });

  test('multiple Work Items cannot share one worktree', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    await boundWorkItem(worktree, 'feature-a');
    await rejectsWith(boundWorkItem(worktree), 'WORKSPACE_CONFLICT');
  });

  test('a completed Work Item releases its worktree for a new one', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const first = await boundWorkItem(worktree, 'feature-a');
    await call(daemon.app, 'complete_work_item', { workItemId: first.id });
    const second = await boundWorkItem(worktree, 'feature-a');
    assert.equal(second.workspace?.worktreeRoot, worktree);
  });

  test('an unbound Work Item cannot run', async () => {
    const item = await call<WorkItem>(daemon.app, 'create_work_item', {
      planId: 'P-1',
      title: 'unbound',
    });
    await rejectsWith(startRun(item.id), 'WORKSPACE_NOT_BOUND');
    assert.equal(agent.invocations.length, 0);
  });

  test('the prompt states the workspace instead of asking the agent to find one', async () => {
    const worktree = addWorktree(repo, join(env.root, 'wt-a'), 'feature-a');
    const item = await boundWorkItem(worktree, 'feature-a');
    const run = await startRun(item.id);
    await daemon.app.runs.waitForRun(run.id);
    const prompt = agent.invocations[0]?.stdin ?? '';
    assert.match(
      prompt,
      new RegExp(`working directory is ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.doesNotMatch(
      prompt,
      /(find|choose|locate|pick) (a|an|the|the right|an appropriate) (worktree|workspace|directory)/i,
    );
  });
});
