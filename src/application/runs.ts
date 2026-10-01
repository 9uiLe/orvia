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
import { requireWorkItem, type RunCanceller } from './work-items.ts';

interface ActiveRun {
  readonly runId: RunId;
  readonly process: RunningProcess;
  cancelRequested: boolean;
}

/**
 * Starts and tracks Agent Runs. Database state is committed before the agent starts and again
 * after it exits; no transaction is open while the agent runs.
 */
export class RunSupervisor implements RunCanceller {
  readonly #deps: Dependencies;
  readonly #storage: StorageService;
  readonly #active = new Map<WorkItemId, ActiveRun>();
  readonly #settled = new Map<RunId, Promise<void>>();

  constructor(deps: Dependencies, storage: StorageService) {
    this.#deps = deps;
    this.#storage = storage;
  }

  /** Marks runs left `running` by a previous daemon process as interrupted. */
  recover(): RunId[] {
    const { store } = this.#deps;
    return store.transaction(() => store.runs.markAllRunningInterrupted(nowIso(this.#deps)));
  }

  async start(input: {
    workItemId: WorkItemId;
    agent: string;
    instructions: string;
  }): Promise<AgentRun> {
    const deps = this.#deps;
    const item = requireWorkItem(deps, input.workItemId);
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
    const active: ActiveRun = { runId: run.id, process, cancelRequested: false };
    this.#active.set(item.id, active);
    deps.logger.info('agent run started', {
      runId: run.id,
      workItemId: item.id,
      agent: adapter.name,
    });

    const settled = process.exited
      .then(async (exit) => {
        const output = await writer.close();
        const status = active.cancelRequested
          ? 'cancelled'
          : exit.exitCode === 0
            ? 'succeeded'
            : 'failed';
        deps.store.transaction(() =>
          deps.store.runs.finish(run.id, {
            status,
            exitCode: exit.exitCode,
            outputBytes: output.bytes,
            outputTruncated: output.truncated,
            now: nowIso(deps),
          }),
        );
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
        this.#settled.delete(run.id);
      })
      .then(async () => {
        await this.#storage.cleanupIfNeeded();
      })
      .catch((error: unknown) => {
        deps.logger.error('storage cleanup after run failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    this.#settled.set(run.id, settled);
    return run;
  }

  cancelForWorkItem(workItemId: WorkItemId): boolean {
    const active = this.#active.get(workItemId);
    if (active === undefined) return false;
    active.cancelRequested = true;
    active.process.cancel();
    this.#deps.logger.info('agent run cancel requested', { runId: active.runId, workItemId });
    return true;
  }

  /** Resolves when the run's final state has been committed (or immediately if unknown). */
  async waitForRun(runId: RunId): Promise<void> {
    await this.#settled.get(runId);
  }

  activeRunCount(): number {
    return this.#active.size;
  }

  /** Stops all agents. Their runs are recorded as interrupted rather than awaited. */
  shutdown(): void {
    for (const [workItemId, active] of this.#active) {
      active.cancelRequested = true;
      active.process.cancel();
      this.#deps.logger.info('agent run interrupted by shutdown', {
        runId: active.runId,
        workItemId,
      });
    }
    this.recover();
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
