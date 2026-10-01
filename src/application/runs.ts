import { randomUUID } from 'node:crypto';
import { OrviaError } from '../domain/errors.ts';
import type { RunId, WorkItemId } from '../domain/ids.ts';
import type { AgentRun } from '../domain/records.ts';
import { filesystemPolicyFor } from '../domain/sandbox.ts';
import { assertWorkspaceMatches, compareWorkspace } from '../domain/workspace.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import type { RunningProcess } from './ports.ts';
import { composeAgentPrompt } from './prompt.ts';
import type { StorageService } from './storage.ts';
import { requireWorkItem, type RunControl } from './work-items.ts';

type StopReason = 'cancelled' | 'interrupted';

interface ActiveRun {
  readonly runId: RunId;
  readonly process: RunningProcess;
  stopReason: StopReason | null;
}

/**
 * Starts and tracks Agent Runs. Database state is committed before the agent starts and again
 * after it exits; no transaction is open while the agent runs.
 */
export class RunSupervisor implements RunControl {
  readonly #deps: Dependencies;
  readonly #storage: StorageService;
  readonly #active = new Map<WorkItemId, ActiveRun>();
  /** Resolves once a run's final state is committed. */
  readonly #recorded = new Map<RunId, Promise<void>>();
  /** Work Items whose agents are being stopped; no new run may start for them meanwhile. */
  readonly #stopping = new Set<WorkItemId>();

  constructor(deps: Dependencies, storage: StorageService) {
    this.#deps = deps;
    this.#storage = storage;
  }

  /**
   * Marks runs left `running` by a previous daemon process as interrupted, one run per
   * transaction: control transactions must stay one-row changes to fit the storage reserve
   * (ADR 0009), and recovery needs no atomicity across runs. If it stops halfway, the next
   * start finishes the rest.
   */
  recover(): RunId[] {
    const { store } = this.#deps;
    const recovered: RunId[] = [];
    for (const run of store.runs.listRunning()) {
      const changed = store.transaction(
        () => store.runs.markInterrupted(run.id, nowIso(this.#deps)),
        'reserve',
      );
      if (changed) recovered.push(run.id);
    }
    return recovered;
  }

  async start(input: {
    workItemId: WorkItemId;
    agent: string;
    instructions: string;
  }): Promise<AgentRun> {
    const deps = this.#deps;
    const item = requireWorkItem(deps, input.workItemId);
    this.#assertNotStopping(item.id);
    if (item.status !== 'active') {
      throw new OrviaError(
        'INVALID_STATE_TRANSITION',
        `work item ${item.id} is ${item.status}; only active work items can run`,
        { workItemId: item.id, status: item.status },
      );
    }
    const workspace = item.workspace;
    if (workspace === null) {
      throw new OrviaError('WORKSPACE_NOT_BOUND', `work item ${item.id} has no bound worktree`, {
        workItemId: item.id,
      });
    }
    const adapter = deps.agents.get(input.agent);
    if (adapter === undefined) {
      throw new OrviaError('AGENT_UNAVAILABLE', `unknown agent ${input.agent}`, {
        agent: input.agent,
        known: [...deps.agents.keys()],
      });
    }
    if ((await deps.launcher.resolveCommand(adapter.command)) === null) {
      throw new OrviaError('AGENT_UNAVAILABLE', `agent command not found: ${adapter.command}`, {
        agent: adapter.name,
      });
    }

    assertWorkspaceMatches(item.id, workspace, await deps.git.observe(workspace.worktreeRoot));

    const outputRef = `runs/${randomUUID()}.log`;
    const { run, prompt } = deps.store.transaction(() => {
      const fresh = requireWorkItem(deps, item.id);
      this.#assertNotStopping(fresh.id);
      if (fresh.status !== 'active') {
        throw new OrviaError(
          'INVALID_STATE_TRANSITION',
          `work item ${item.id} is ${fresh.status}`,
          {
            workItemId: item.id,
            status: fresh.status,
          },
        );
      }
      if (fresh.workspace === null || compareWorkspace(workspace, fresh.workspace).length > 0) {
        throw new OrviaError('WORKSPACE_MISMATCH', `work item ${item.id} was rebound`, {
          workItemId: item.id,
          reasons: ['worktree_changed'],
        });
      }
      const plan = requirePlan(deps, fresh.planId);
      return {
        run: deps.store.runs.insert({
          workItemId: fresh.id,
          agent: adapter.name,
          outputRef,
          now: nowIso(deps),
        }),
        prompt: composeAgentPrompt({
          plan,
          workItem: fresh,
          workspace,
          decisions: deps.store.decisions.listForPlan(plan.id),
          notes: deps.store.notes.listForPlan(plan.id),
          instructions: input.instructions,
        }),
      };
    });

    const invocation = adapter.buildInvocation({ policy: filesystemPolicyFor(workspace), prompt });
    const writer = deps.cache.createWriter(outputRef);
    const process = deps.launcher.launch(invocation, (chunk) => {
      writer.write(chunk);
    });
    const active: ActiveRun = { runId: run.id, process, stopReason: null };
    this.#active.set(item.id, active);
    deps.logger.info('agent run started', {
      runId: run.id,
      workItemId: item.id,
      agent: adapter.name,
    });

    const recorded = process.exited
      .then(async (exit) => {
        const output = await writer.close();
        const status =
          active.stopReason ??
          (exit.exitCode === 0 && exit.leftoverError === null ? 'succeeded' : 'failed');
        deps.store.transaction(
          () =>
            deps.store.runs.finish(run.id, {
              status,
              exitCode: exit.exitCode,
              outputBytes: output.bytes,
              outputTruncated: output.truncated,
              now: nowIso(deps),
            }),
          'reserve',
        );
        if (exit.leftoverError !== null) {
          deps.logger.error('processes left by the agent could not be stopped', {
            runId: run.id,
            error: exit.leftoverError,
          });
        }
        deps.logger.info('agent run finished', {
          runId: run.id,
          status,
          exitCode: exit.exitCode,
          spawnError: exit.spawnError,
        });
      })
      .catch((error: unknown) => {
        deps.logger.error('failed to record agent run result', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#active.delete(item.id);
        this.#recorded.delete(run.id);
      });
    this.#recorded.set(run.id, recorded);
    recorded
      .then(() => this.#storage.cleanupIfNeeded())
      .catch((error: unknown) => {
        deps.logger.error('storage cleanup after run failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return run;
  }

  /**
   * Stops the Work Item's agent process tree, waits until its run is recorded, then commits
   * `commit` (the pause). If the tree cannot be confirmed stopped, nothing is committed and
   * AGENT_TERMINATION_FAILED is thrown, so the Work Item never shows as paused while its agent
   * still runs.
   */
  async pause<T>(workItemId: WorkItemId, commit: () => T): Promise<T> {
    this.#assertNotStopping(workItemId);
    this.#stopping.add(workItemId);
    try {
      await this.#stop(workItemId, 'cancelled');
      return commit();
    } finally {
      this.#stopping.delete(workItemId);
    }
  }

  /** Resolves when the run's final state has been committed (or immediately if unknown). */
  async waitForRun(runId: RunId): Promise<void> {
    await this.#recorded.get(runId);
  }

  activeRunCount(): number {
    return this.#active.size;
  }

  /**
   * Stops every agent process tree and records those runs as interrupted. Runs whose processes
   * could not be confirmed stopped are marked interrupted afterwards and logged as errors,
   * because the daemon is going away either way.
   */
  async shutdown(): Promise<void> {
    const ids = [...this.#active.keys()];
    ids.forEach((id) => this.#stopping.add(id));
    const results = await Promise.allSettled(ids.map((id) => this.#stop(id, 'interrupted')));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.#deps.logger.error('agent process tree may still be running after shutdown', {
          workItemId: ids[index] ?? null,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    this.recover();
  }

  async #stop(workItemId: WorkItemId, reason: StopReason): Promise<void> {
    const active = this.#active.get(workItemId);
    if (active === undefined) return;
    active.stopReason ??= reason;
    this.#deps.logger.info('stopping agent run', { runId: active.runId, workItemId, reason });
    try {
      await active.process.terminate();
    } catch (error) {
      active.stopReason = null;
      throw error;
    }
    await this.#recorded.get(active.runId);
  }

  #assertNotStopping(workItemId: WorkItemId): void {
    if (this.#stopping.has(workItemId)) {
      throw new OrviaError('INVALID_STATE_TRANSITION', `work item ${workItemId} is being paused`, {
        workItemId,
      });
    }
  }

  async readOutput(input: { runId: RunId; maxBytes: number }): Promise<{
    run: AgentRun;
    output: string | null;
  }> {
    const run = this.#deps.store.runs.get(input.runId);
    if (run === null) throw new OrviaError('NOT_FOUND', `run ${input.runId} not found`);
    const output =
      run.outputRef === null
        ? null
        : await this.#deps.cache.readTail(run.outputRef, input.maxBytes);
    return { run, output };
  }
}
