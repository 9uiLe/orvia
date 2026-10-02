import { randomUUID } from 'node:crypto';
import { isOrviaError, OrviaError } from '../domain/errors.ts';
import type { CycleId, RunId, WorkItemId } from '../domain/ids.ts';
import { requiredCapabilitiesFor } from '../domain/agent-profile.ts';
import type { StageState } from '../domain/cycle.ts';
import type { AgentRun, RunPurpose } from '../domain/records.ts';
import { filesystemPolicyFor } from '../domain/sandbox.ts';
import { assertWorkspaceMatches, compareWorkspace } from '../domain/workspace.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import { MAX_RESULT_BYTES } from './agent-results.ts';
import { assertCapable, requireProfile } from './agent-profiles.ts';
import type { AgentAdapter, AgentRunRequest, OutputWriter, RunningProcess } from './ports.ts';
import { composeAgentPrompt } from './prompt.ts';
import { runCacheRefs, type StorageService } from './storage.ts';
import { requireWorkItem, type RunControl } from './work-items.ts';

type StopReason = 'cancelled' | 'interrupted';

/** What a run left for its cycle to read. */
export type StageOutput =
  /** The run was not asked for a structured result. */
  | { readonly kind: 'none' }
  /** `text` is null when the agent's output held no result. */
  | { readonly kind: 'result'; readonly text: string | null }
  /** stdout went past what the adapter may produce for a result within the limits. */
  | { readonly kind: 'oversized' }
  /** Orvia could not keep the output (write error, or the file is gone). */
  | { readonly kind: 'lost' };

export interface StartRunInput {
  readonly workItemId: WorkItemId;
  readonly profileId: string;
  readonly instructions: string;
  readonly purpose?: RunPurpose;
  readonly cycleId?: CycleId | null;
  /**
   * The cycle stage this run performs. The profile must have the stage's required
   * capabilities, and the run is granted exactly those. A manual run gets whatever the
   * profile has.
   */
  readonly stage?: StageState;
  /** JSON Schema the agent's final answer must match; the result is passed to onFinished. */
  readonly resultSchema?: Record<string, unknown>;
  /** Runs inside the transaction that records the run, before the agent starts. */
  readonly withinTransaction?: (run: AgentRun) => void;
}

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
  #closing = false;

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

  /**
   * Called once a run's final state is committed, with its structured result text when the run
   * was started with a result schema. Awaited before the run counts as recorded, so shutdown
   * sees its effects.
   */
  onFinished: ((run: AgentRun, output: StageOutput) => Promise<void>) | null = null;

  async start(input: StartRunInput): Promise<AgentRun> {
    const deps = this.#deps;
    const purpose = input.purpose ?? 'manual';
    if (this.#closing) {
      throw new OrviaError('INVALID_STATE_TRANSITION', 'the daemon is shutting down');
    }
    const item = requireWorkItem(deps, input.workItemId);
    this.#assertNotStopping(item.id);
    if (purpose === 'manual' && deps.store.cycles.active(item.id) !== null) {
      throw new OrviaError(
        'CYCLE_ACTIVE',
        `work item ${item.id} has an active cycle; control it with the cycle operations`,
        { workItemId: item.id },
      );
    }
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
    const profile = requireProfile(deps.profiles, input.profileId);
    if (input.stage !== undefined) assertCapable(profile, input.stage);
    const granted =
      input.stage === undefined
        ? profile.capabilities.filter((capability) => capability !== 'structuredResult')
        : requiredCapabilitiesFor(input.stage);
    if ((await deps.launcher.resolveCommand(profile.command)) === null) {
      throw new OrviaError(
        'AGENT_UNAVAILABLE',
        `agent profile ${profile.id}: command not found: ${profile.command}`,
        { profileId: profile.id, command: profile.command },
      );
    }

    assertWorkspaceMatches(item.id, workspace, await deps.git.observe(workspace.worktreeRoot));

    const refs = runCacheRefs(`runs/${randomUUID()}.log`);
    const outputRef = refs.log;
    const resultRef = input.resultSchema === undefined ? null : refs.result;
    const schemaRef = input.resultSchema === undefined ? null : refs.schema;
    // One byte past what the adapter needs, so an oversized result is seen as oversized.
    const resultBytes = profile.adapter.resultStdoutBytes(MAX_RESULT_BYTES) + 1;
    const recordRun = () =>
      deps.store.transaction(() => {
        if (this.#closing) {
          throw new OrviaError('INVALID_STATE_TRANSITION', 'the daemon is shutting down');
        }
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
          run: (() => {
            const inserted = deps.store.runs.insert({
              workItemId: fresh.id,
              profileId: profile.id,
              outputRef,
              purpose,
              cycleId: input.cycleId ?? null,
              now: nowIso(deps),
            });
            input.withinTransaction?.(inserted);
            return inserted;
          })(),
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
    // Written before the run is recorded: from the insert until the process is tracked in
    // #active there must be no await, or a pause in between would miss the process.
    let result: AgentRunRequest['result'] = null;
    let resultWriter: OutputWriter | null = null;
    let inserted: ReturnType<typeof recordRun>;
    try {
      if (input.resultSchema !== undefined && schemaRef !== null && resultRef !== null) {
        // The result's space is set aside before the agent starts, so verbose logging cannot
        // crowd out the structured result the cycle depends on.
        resultWriter = deps.cache.createWriter(resultRef, { reserveBytes: resultBytes });
        const schema = new TextEncoder().encode(JSON.stringify(input.resultSchema));
        const schemaWriter = deps.cache.createWriter(schemaRef, {
          reserveBytes: schema.byteLength,
        });
        schemaWriter.write(schema);
        await schemaWriter.close();
        result = { schema: input.resultSchema, schemaPath: deps.cache.absolutePath(schemaRef) };
      }
      inserted = recordRun();
    } catch (error) {
      await resultWriter?.close();
      await deps.cache.remove([refs.result, refs.schema]);
      throw error;
    }
    const { run, prompt } = inserted;

    const invocation = profile.adapter.buildInvocation(profile.command, {
      policy: filesystemPolicyFor(workspace),
      prompt,
      capabilities: granted,
      result,
    });
    // The structured result is read from stdout alone; the log keeps both streams.
    const writer = deps.cache.createWriter(outputRef);
    const process = deps.launcher.launch(invocation, (chunk, stream) => {
      writer.write(chunk);
      if (stream === 'stdout') resultWriter?.write(chunk);
    });
    const active: ActiveRun = { runId: run.id, process, stopReason: null };
    this.#active.set(item.id, active);
    deps.logger.info('agent run started', {
      runId: run.id,
      workItemId: item.id,
      profileId: profile.id,
    });

    const recorded = process.exited
      .then(async (exit) => {
        const output = await writer.close();
        const resultOutput = (await resultWriter?.close()) ?? null;
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
        this.#forget(item.id, run.id);
        if (this.onFinished !== null) {
          const finished = deps.store.runs.get(run.id);
          if (finished !== null) {
            await this.onFinished(
              finished,
              await this.#stageOutput(profile.adapter, resultRef, resultBytes, resultOutput),
            );
          }
        }
      })
      .catch((error: unknown) => {
        deps.logger.error('failed to record agent run result', {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#forget(item.id, run.id);
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
    this.#closing = true;
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

  async #stageOutput(
    adapter: AgentAdapter,
    resultRef: string | null,
    resultBytes: number,
    written: { truncated: boolean; failed: boolean } | null,
  ): Promise<StageOutput> {
    if (resultRef === null || written === null) return { kind: 'none' };
    if (written.failed) return { kind: 'lost' };
    if (written.truncated) return { kind: 'oversized' };
    const stdout = await this.#deps.cache.readHead(resultRef, resultBytes);
    if (stdout === null) return { kind: 'lost' };
    return { kind: 'result', text: adapter.extractResult(stdout) };
  }

  /** The listener may already have started the Work Item's next run; leave that one tracked. */
  #forget(workItemId: WorkItemId, runId: RunId): void {
    if (this.#active.get(workItemId)?.runId === runId) this.#active.delete(workItemId);
  }

  /** Stops the Work Item's running agent, if any, and waits until its run is recorded. */
  async stopRun(workItemId: WorkItemId): Promise<void> {
    await this.#stop(workItemId, 'cancelled');
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
