import { randomUUID } from 'node:crypto';
import { isOrviaError, OrviaError } from '../domain/errors.ts';
import type { CycleId, RunId, WorkItemId } from '../domain/ids.ts';
import { requiredCapabilitiesFor } from '../domain/agent-profile.ts';
import type { StageState } from '../domain/cycle.ts';
import type { AgentRun, RunPurpose } from '../domain/records.ts';
import { assertOperationAllowed, type OperationClass } from '../domain/storage.ts';
import { assertWorkItemCanRun, requireBoundWorkspace } from '../domain/work-item.ts';
import { filesystemPolicyFor } from '../domain/sandbox.ts';
import { assertWorkspaceMatches, compareWorkspace } from '../domain/workspace.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import { MAX_RESULT_BYTES, resultJsonSchema, type ResultPurpose } from './agent-results.ts';
import { assertCapable, assertCommandAvailable, requireProfile } from './agent-profiles.ts';
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

const STAGE_PURPOSE: Record<StageState, Exclude<RunPurpose, 'manual'> & ResultPurpose> = {
  IMPLEMENTING: 'implementation',
  VERIFYING: 'verification',
  REVIEWING: 'review',
  FIXING: 'fix',
};

export type StartRunInput = {
  readonly workItemId: WorkItemId;
  readonly profileId: string;
  readonly instructions: string;
  /** Runs inside the transaction that records the run, before the agent starts. */
  readonly withinTransaction?: (run: AgentRun) => void;
} & (
  | {
      /** A human-started run: the profile's own capabilities, no structured result. */
      readonly kind: 'manual';
    }
  | {
      /**
       * A cycle's stage run. The profile must have the stage's required capabilities and the
       * run is granted exactly those. The stage fixes the purpose and the result schema, and
       * the result is passed to the finished-run listener.
       */
      readonly kind: 'cycleStage';
      readonly cycleId: CycleId;
      readonly stage: StageState;
    }
);

/** The gates every operation that starts agent work passes before it runs. */
export async function assertAgentWorkAllowed(
  runs: RunSupervisor,
  storage: StorageService,
  operation: string,
  operationClass: OperationClass,
): Promise<void> {
  if (runs.recoveryStatus().state === 'incomplete') {
    throw recoveryIncompleteError(runs.recoveryStatus(), operation);
  }
  assertOperationAllowed(await storage.assess(), operationClass);
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
   * transaction: control transactions must stay one-row changes, and recovery needs
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
  #onFinished: ((run: AgentRun, output: StageOutput) => Promise<void>) | null = null;

  onFinished(listener: (run: AgentRun, output: StageOutput) => Promise<void>): void {
    if (this.#onFinished !== null)
      throw new OrviaError('INTERNAL', 'a run listener is already set');
    this.#onFinished = listener;
  }

  async start(input: StartRunInput): Promise<AgentRun> {
    const deps = this.#deps;
    const stage = input.kind === 'cycleStage' ? input.stage : undefined;
    const purpose = stage === undefined ? 'manual' : STAGE_PURPOSE[stage];
    const resultSchema = stage === undefined ? undefined : resultJsonSchema(STAGE_PURPOSE[stage]);
    const cycleId = input.kind === 'cycleStage' ? input.cycleId : null;
    if (this.#closing) {
      throw new OrviaError('INVALID_STATE_TRANSITION', 'the daemon is shutting down');
    }
    const item = requireWorkItem(deps, input.workItemId);
    this.#assertNotStopping(item.id);
    const assertNoCycleForManualRun = (): void => {
      if (input.kind === 'manual' && deps.store.cycles.active(item.id) !== null) {
        throw new OrviaError(
          'CYCLE_ACTIVE',
          `work item ${item.id} has an active cycle; control it with the cycle operations`,
          { workItemId: item.id },
        );
      }
    };
    assertNoCycleForManualRun();
    assertWorkItemCanRun(item);
    const workspace = requireBoundWorkspace(item);
    const profile = requireProfile(deps.profiles, input.profileId);
    if (stage !== undefined) assertCapable(profile, stage);
    const granted =
      stage === undefined
        ? profile.capabilities.filter((capability) => capability !== 'structuredResult')
        : requiredCapabilitiesFor(stage);
    await assertCommandAvailable(profile, deps.launcher);

    assertWorkspaceMatches(item.id, workspace, await deps.git.observe(workspace.worktreeRoot));

    const refs = runCacheRefs(`runs/${randomUUID()}.log`);
    const outputRef = refs.log;
    const resultRef = resultSchema === undefined ? null : refs.result;
    const schemaRef = resultSchema === undefined ? null : refs.schema;
    // One byte past what the adapter needs, so an oversized result is seen as oversized.
    const resultBytes = profile.adapter.resultStdoutBytes(MAX_RESULT_BYTES) + 1;
    const recordRun = () =>
      deps.store.transaction(() => {
        if (this.#closing) {
          throw new OrviaError('INVALID_STATE_TRANSITION', 'the daemon is shutting down');
        }
        const fresh = requireWorkItem(deps, item.id);
        this.#assertNotStopping(fresh.id);
        assertWorkItemCanRun(fresh);
        assertNoCycleForManualRun();
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
              cycleId,
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
      if (resultSchema !== undefined && schemaRef !== null && resultRef !== null) {
        // The result's space is set aside before the agent starts, so verbose logging cannot
        // crowd out the structured result the cycle depends on.
        resultWriter = deps.cache.createWriter(resultRef, { reserveBytes: resultBytes });
        const schema = new TextEncoder().encode(JSON.stringify(resultSchema));
        const schemaWriter = deps.cache.createWriter(schemaRef, {
          reserveBytes: schema.byteLength,
        });
        schemaWriter.write(schema);
        await schemaWriter.close();
        result = { schema: resultSchema, schemaPath: deps.cache.absolutePath(schemaRef) };
      }
      inserted = recordRun();
    } catch (error) {
      await resultWriter?.close();
      await deps.cache.remove([refs.result, refs.schema]);
      throw error;
    }
    const { run, prompt } = inserted;

    let writer: OutputWriter | null = null;
    let process: RunningProcess;
    try {
      const invocation = profile.adapter.buildInvocation(profile.command, {
        policy: filesystemPolicyFor(workspace),
        prompt,
        capabilities: granted,
        result,
      });
      // The structured result is read from stdout alone; the log keeps both streams.
      const logWriter = deps.cache.createWriter(outputRef);
      writer = logWriter;
      process = deps.launcher.launch(invocation, (chunk, stream) => {
        logWriter.write(chunk);
        if (stream === 'stdout') resultWriter?.write(chunk);
      });
    } catch (error) {
      // Synchronous, so the run is never left `running` without a process to stop.
      try {
        deps.store.transaction(
          () =>
            deps.store.runs.finish(run.id, {
              status: 'failed',
              exitCode: null,
              outputBytes: 0,
              outputTruncated: false,
              now: nowIso(deps),
            }),
          'reserve',
        );
      } catch (finishError) {
        deps.logger.error('could not record a run that failed to start', {
          runId: run.id,
          error: finishError instanceof Error ? finishError.message : String(finishError),
        });
      }
      await writer?.close();
      await resultWriter?.close();
      await deps.cache.remove([refs.result, refs.schema]);
      throw error;
    }
    const logWriter = writer;
    const active: ActiveRun = { runId: run.id, process, stopReason: null };
    this.#active.set(item.id, active);
    deps.logger.info('agent run started', {
      runId: run.id,
      workItemId: item.id,
      profileId: profile.id,
    });

    const recorded = process.exited
      .then(async (exit) => {
        const output = await logWriter.close();
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
        const finished = deps.store.runs.get(run.id);
        if (this.#onFinished !== null && finished !== null) {
          await this.#onFinished(
            finished,
            await this.#stageOutput(profile.adapter, resultRef, resultBytes, resultOutput),
          );
        } else if (this.#onFinished === null && cycleId !== null) {
          deps.logger.error('the result of a cycle run was dropped: no listener', {
            runId: run.id,
          });
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
      // A run stopped by shutdown finishes after the database is closed.
      .then(() => (this.#closing ? null : this.#storage.cleanupIfNeeded()))
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
