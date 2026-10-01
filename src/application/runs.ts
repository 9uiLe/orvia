import { randomUUID } from 'node:crypto';
import { isOrviaError, OrviaError } from '../domain/errors.ts';
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

export type RecoveryResult =
  | { readonly state: 'complete'; readonly recoveredRunIds: readonly RunId[] }
  | {
      readonly state: 'incomplete';
      readonly recoveredRunIds: readonly RunId[];
      readonly remainingRunIds: readonly RunId[];
      readonly reason: 'STORAGE_HARD_LIMIT';
    };

export const RECOVERY_REMEDIATION =
  'Run `orvia cleanup` (it helps if old run records or backups take the space; it cannot help ' +
  'when durable data fills the budget) or raise storage.database_max_mb, then restart the daemon.';

export function recoveryIncompleteError(
  recovery: RecoveryResult,
  operation: string,
  runId?: RunId,
): OrviaError {
  const remaining = recovery.state === 'incomplete' ? recovery.remainingRunIds.length : 0;
  return new OrviaError(
    'RECOVERY_INCOMPLETE',
    `${operation} is unavailable: ${remaining} run(s) of a previous daemon are still marked ` +
      `running because the database storage reserve ran out during startup recovery. ` +
      RECOVERY_REMEDIATION,
    { operation, remainingRuns: remaining, ...(runId === undefined ? {} : { runId }) },
  );
}

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
  #recovery: RecoveryResult = { state: 'complete', recoveredRunIds: [] };

  constructor(deps: Dependencies, storage: StorageService) {
    this.#deps = deps;
    this.#storage = storage;
  }

  /**
   * Marks runs left `running` by a previous daemon process as interrupted, one run per
   * transaction: control transactions must stay one-row changes (ADR 0009), and recovery needs
   * no atomicity across runs. Runs already marked stay marked, so a later recovery only handles
   * the runs still `running`.
   *
   * If the shared storage reserve runs out, recovery stops and reports the remaining runs
   * instead of failing: the daemon then starts in a degraded state where it can be inspected and
   * cleaned up. Restarting alone does not free reserve; cleanup or a larger
   * storage.database_max_mb does. Any other error still fails startup.
   */
  recover(): RecoveryResult {
    const { store } = this.#deps;
    const pending = store.runs.listRunning();
    const recoveredRunIds: RunId[] = [];
    for (const [index, run] of pending.entries()) {
      try {
        const changed = store.transaction(
          () => store.runs.markInterrupted(run.id, nowIso(this.#deps)),
          'reserve',
        );
        if (changed) recoveredRunIds.push(run.id);
      } catch (error) {
        if (!isOrviaError(error) || error.code !== 'STORAGE_HARD_LIMIT') throw error;
        this.#recovery = {
          state: 'incomplete',
          recoveredRunIds,
          remainingRunIds: pending.slice(index).map((remaining) => remaining.id),
          reason: 'STORAGE_HARD_LIMIT',
        };
        return this.#recovery;
      }
    }
    this.#recovery = { state: 'complete', recoveredRunIds };
    return this.#recovery;
  }

  /** The result of the last recovery; `incomplete` puts the daemon in its degraded state. */
  recoveryStatus(): RecoveryResult {
    return this.#recovery;
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
    const current = this.#deps.store.runs.current(workItemId);
    if (current !== null && !this.#active.has(workItemId)) {
      // A `running` record this daemon does not own is an unrecovered run of a previous daemon.
      // Pausing would show the Work Item paused next to a run still marked running, and this
      // daemon cannot confirm or stop a process it never started.
      throw recoveryIncompleteError(this.#recovery, 'pause_work_item', current.id);
    }
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
    const recovery = this.recover();
    if (recovery.state === 'incomplete') {
      this.#deps.logger.error('could not record every stopped run before shutdown', {
        remaining: recovery.remainingRunIds.length,
      });
    }
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
