import {
  assertTransition,
  firstStage,
  isStage,
  resumeStageAfterEscalation,
  resumeTarget,
  type Cycle,
  type CycleMode,
  type CycleReason,
  type CycleState,
  type StageState,
} from '../domain/cycle.ts';
import { isOrviaError, OrviaError } from '../domain/errors.ts';
import type { CycleId, ReviewId, RunId, WorkItemId } from '../domain/ids.ts';
import type { AgentRun, RunPurpose } from '../domain/records.ts';
import {
  classifyFinding,
  nextAfterReview,
  nextAfterVerification,
  type Finding,
  type NextStep,
  type Review,
} from '../domain/review.ts';
import { assertOperationAllowed } from '../domain/storage.ts';
import {
  parseFixResult,
  parseImplementationResult,
  parseReviewResult,
  parseVerificationResult,
  resultJsonSchema,
  ResultProtocolError,
  type ResultPurpose,
  type VerificationResult,
} from './agent-results.ts';
import {
  fixInstructions,
  implementationInstructions,
  reviewInstructions,
  verificationInstructions,
} from './cycle-prompts.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import type { CyclePatch, TransactionMode } from './ports.ts';
import { recoveryIncompleteError, type RunSupervisor } from './runs.ts';
import type { StorageService } from './storage.ts';
import { requireWorkItem } from './work-items.ts';

/** The stage a waiting cycle goes back to when resumed. */
function resumeStageFor(target: CycleState, from: StageState): StageState | null {
  if (target === 'BLOCKED' || target === 'PAUSED') return from;
  if (target === 'NEEDS_HUMAN') return resumeStageAfterEscalation(from);
  return null;
}

const PURPOSE: Record<StageState, ResultPurpose> = {
  IMPLEMENTING: 'implementation',
  VERIFYING: 'verification',
  REVIEWING: 'review',
  FIXING: 'fix',
};

export interface CycleDetails {
  readonly cycle: Cycle;
  readonly runs: readonly AgentRun[];
  readonly latestReview: Review | null;
  /** Findings of the latest review that wait for a human. */
  readonly needsHumanFindingIds: readonly string[];
}

/**
 * Drives orchestration cycles: starts each stage's agent, validates its structured result,
 * applies Orvia's policy, and moves the cycle on. Every state change goes through the domain's
 * transition table inside a short transaction; agents run outside transactions.
 */
export class CycleSupervisor {
  readonly #deps: Dependencies;
  readonly #runs: RunSupervisor;
  readonly #storage: StorageService;

  constructor(deps: Dependencies, runs: RunSupervisor, storage: StorageService) {
    this.#deps = deps;
    this.#runs = runs;
    this.#storage = storage;
    runs.onFinished = (run, rawResult) => this.#onRunFinished(run, rawResult);
  }

  async start(input: {
    workItemId: WorkItemId;
    mode: CycleMode;
    instructions: string;
    implementationAgent: string;
    reviewAgent: string;
  }): Promise<Cycle> {
    const { store } = this.#deps;
    for (const agent of [input.implementationAgent, input.reviewAgent]) {
      if (!this.#deps.agents.has(agent)) {
        throw new OrviaError('AGENT_UNAVAILABLE', `unknown agent ${agent}`, {
          agent,
          known: [...this.#deps.agents.keys()],
        });
      }
    }
    const stage = firstStage(input.mode);
    const cycle = store.transaction(() => {
      const item = requireWorkItem(this.#deps, input.workItemId);
      if (item.status !== 'active') {
        throw new OrviaError('INVALID_STATE_TRANSITION', `work item ${item.id} is ${item.status}`, {
          workItemId: item.id,
        });
      }
      if (item.workspace === null) {
        throw new OrviaError('WORKSPACE_NOT_BOUND', `work item ${item.id} has no bound worktree`, {
          workItemId: item.id,
        });
      }
      const active = store.cycles.active(item.id);
      if (active !== null) {
        throw new OrviaError(
          'CYCLE_ACTIVE',
          `work item ${item.id} already has cycle ${active.id}`,
          {
            workItemId: item.id,
            cycleId: active.id,
          },
        );
      }
      if (store.runs.current(item.id) !== null) {
        throw new OrviaError('RUN_IN_PROGRESS', `work item ${item.id} has a running agent`, {
          workItemId: item.id,
        });
      }
      return store.cycles.insert({
        workItemId: item.id,
        mode: input.mode,
        state: stage,
        maxAutoFixRounds: this.#deps.orchestration.maxAutoFixRounds,
        implementationAgent: input.implementationAgent,
        reviewAgent: input.reviewAgent,
        instructions: input.instructions,
        now: nowIso(this.#deps),
      });
    });
    await this.#launchOrBlock(cycle, stage, true);
    return this.#require(cycle.id);
  }

  get(input: { cycleId: CycleId }): CycleDetails {
    const { store } = this.#deps;
    const cycle = this.#require(input.cycleId);
    const latestReview = store.reviews.latestForCycle(cycle.id);
    return {
      cycle,
      runs: store.runs.listForCycle(cycle.id),
      latestReview,
      needsHumanFindingIds:
        latestReview === null
          ? []
          : store.reviews
              .findings(latestReview.id)
              .filter((finding) => finding.policyAction === 'NEEDS_HUMAN')
              .map((finding) => finding.id),
    };
  }

  currentReview(input: { cycleId: CycleId }): { review: Review | null; findings: Finding[] } {
    const review = this.#deps.store.reviews.latestForCycle(this.#require(input.cycleId).id);
    return {
      review,
      findings: review === null ? [] : this.#deps.store.reviews.findings(review.id),
    };
  }

  review(input: { reviewId: ReviewId }): { review: Review; findings: Finding[] } {
    const review = this.#deps.store.reviews.get(input.reviewId);
    if (review === null) {
      throw new OrviaError('NOT_FOUND', `review ${input.reviewId} not found`, {
        reviewId: input.reviewId,
      });
    }
    return { review, findings: this.#deps.store.reviews.findings(review.id) };
  }

  /**
   * Stops the cycle's running agent with the Foundation's process-tree termination, then
   * records PAUSED. If the agent cannot be confirmed stopped, the cycle is not paused.
   */
  async pause(input: { cycleId: CycleId }): Promise<Cycle> {
    return this.#stopAndCommit(input.cycleId, (cycle) => {
      if (!isStage(cycle.state)) {
        throw new OrviaError(
          'INVALID_STATE_TRANSITION',
          `cycle ${cycle.id} is ${cycle.state}; nothing runs`,
          { cycleId: cycle.id, state: cycle.state },
        );
      }
      return { state: 'PAUSED', reason: 'PAUSED_BY_HUMAN', resumeStage: cycle.state };
    });
  }
  /**
   * Continues a paused, blocked, or escalated cycle. Every stage prompt is built at launch from
   * the latest Plan, decisions, and context, and the workspace identity is validated again.
   */
  async resume(input: { cycleId: CycleId }): Promise<Cycle> {
    const cycle = this.#require(input.cycleId);
    const target = resumeTarget(cycle);
    const item = requireWorkItem(this.#deps, cycle.workItemId);
    if (item.status !== 'active') {
      throw new OrviaError(
        'INVALID_STATE_TRANSITION',
        `work item ${item.id} is ${item.status}; resume the work item first`,
        { workItemId: item.id },
      );
    }
    const resumed = this.#commit(cycle.id, 'write', (fresh) =>
      fresh.state === cycle.state
        ? {
            state: target,
            reason: null,
            resumeStage: null,
            // A human looked at the cycle; the automatic-fix budget starts again.
            ...(fresh.state === 'NEEDS_HUMAN' ? { autoFixRounds: 0 } : {}),
          }
        : null,
    );
    if (resumed === null) {
      throw new OrviaError('INVALID_STATE_TRANSITION', `cycle ${cycle.id} changed state`, {
        cycleId: cycle.id,
      });
    }
    await this.#launchOrBlock(resumed, target, true);
    return this.#require(cycle.id);
  }

  async cancel(input: { cycleId: CycleId }): Promise<Cycle> {
    return this.#stopAndCommit(input.cycleId, (cycle) => {
      assertTransition(cycle, 'CANCELLED');
      return { state: 'CANCELLED', reason: 'CANCELLED_BY_HUMAN', completedAt: nowIso(this.#deps) };
    });
  }

  /**
   * Stops the cycle's agent, then commits `change` only if no other run started meanwhile.
   * stopRun returns after the finished run's listener, which may have launched the next stage;
   * in that case the new run is stopped too before anything is recorded.
   */
  async #stopAndCommit(
    cycleId: CycleId,
    change: (cycle: Cycle) => CyclePatch & { state: CycleState },
  ): Promise<Cycle> {
    for (;;) {
      const cycle = this.#require(cycleId);
      const patch = change(cycle);
      if (isStage(cycle.state)) await this.#runs.stopRun(cycle.workItemId);
      const committed = this.#commit(cycleId, 'reserve', (fresh) =>
        fresh.state === cycle.state && fresh.currentRunId === cycle.currentRunId ? patch : null,
      );
      if (committed !== null) return committed;
    }
  }

  /**
   * After a restart the new daemon owns no agent process, so every cycle that was in a stage
   * stops as BLOCKED. Nothing is relaunched until a human resumes it. One cycle per
   * transaction, like other startup recovery.
   */
  blockInterrupted(): CycleId[] {
    const blocked: CycleId[] = [];
    for (const cycle of this.#deps.store.cycles.listActive()) {
      if (!isStage(cycle.state)) continue;
      const updated = this.#commit(cycle.id, 'reserve', (fresh) =>
        isStage(fresh.state)
          ? { state: 'BLOCKED', reason: 'RUN_INTERRUPTED', resumeStage: fresh.state }
          : null,
      );
      if (updated !== null) blocked.push(cycle.id);
    }
    return blocked;
  }

  async #onRunFinished(run: AgentRun, rawResult: string | null): Promise<void> {
    if (run.cycleId === null) return;
    const cycle = this.#deps.store.cycles.get(run.cycleId);
    if (cycle?.currentRunId !== run.id || !isStage(cycle.state)) return;
    // Whoever stopped a cancelled run (pause or cancel) records the cycle's new state.
    if (run.status === 'cancelled') return;
    if (run.status === 'interrupted') {
      this.#stop(cycle, run.id, 'BLOCKED', 'RUN_INTERRUPTED');
      return;
    }
    if (run.status !== 'succeeded') {
      this.#stop(cycle, run.id, 'BLOCKED', 'RUN_FAILED');
      return;
    }
    let next: NextStep;
    try {
      next = this.#applyResult(cycle, run, rawResult);
    } catch (error) {
      if (isOrviaError(error) && error.code === 'STORAGE_HARD_LIMIT') {
        // The result did not fit in the ordinary write capacity. Only the state change goes
        // into the control reserve; resuming after cleanup runs the stage again.
        this.#stop(cycle, run.id, 'BLOCKED', 'STORAGE_HARD_LIMIT');
        return;
      }
      if (!(error instanceof ResultProtocolError)) {
        // A bug, not an agent problem: stop the cycle visibly rather than leave it in a stage.
        this.#deps.logger.error('cycle could not advance', {
          cycleId: cycle.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#stop(cycle, run.id, 'FAILED', 'INTERNAL_ERROR');
        return;
      }
      this.#deps.logger.warn('agent result rejected', {
        cycleId: cycle.id,
        runId: run.id,
        problems: error.problems.length,
      });
      this.#stop(
        cycle,
        run.id,
        'BLOCKED',
        cycle.state === 'REVIEWING' ? 'REVIEW_PROTOCOL_INVALID' : 'RESULT_PROTOCOL_INVALID',
      );
      return;
    }
    if (next.state === 'FIXING' || next.state === 'REVIEWING' || next.state === 'VERIFYING') {
      const advanced = this.#require(cycle.id);
      if (advanced.state === next.state) await this.#launchOrBlock(advanced, next.state, false);
    }
  }

  /** Validates a stage's result and commits its effects and the next state in one transaction. */
  #applyResult(cycle: Cycle, run: AgentRun, rawResult: string | null): NextStep {
    const { store } = this.#deps;
    const budget = { autoFixRounds: cycle.autoFixRounds, maxAutoFixRounds: cycle.maxAutoFixRounds };
    switch (cycle.state as StageState) {
      case 'IMPLEMENTING': {
        const result = parseImplementationResult(rawResult);
        const next: NextStep =
          result.status === 'needs_input'
            ? { state: 'NEEDS_HUMAN', reason: 'AGENT_NEEDS_INPUT' }
            : { state: 'VERIFYING' };
        return this.#record(cycle, run, JSON.stringify(result), next, () => undefined);
      }
      case 'VERIFYING': {
        const result = parseVerificationResult(rawResult);
        return this.#record(
          cycle,
          run,
          JSON.stringify(result),
          nextAfterVerification(result.status, budget),
          () => undefined,
        );
      }
      case 'REVIEWING': {
        const result = parseReviewResult(rawResult);
        const classified = result.findings.map((finding) => ({
          finding,
          policy: classifyFinding(finding),
        }));
        const next = nextAfterReview(
          { verdict: result.verdict, actions: classified.map((item) => item.policy.action) },
          budget,
        );
        return this.#record(cycle, run, null, next, () => {
          const review = store.reviews.insert({
            cycleId: cycle.id,
            runId: run.id,
            iteration: cycle.iteration + 1,
            verdict: result.verdict,
            summary: result.summary,
            now: nowIso(this.#deps),
          });
          for (const { finding, policy } of classified) {
            store.reviews.insertFinding({
              reviewId: review.id,
              category: finding.category,
              title: finding.title,
              detail: finding.detail,
              evidence: finding.evidence,
              suggestedAction: finding.suggestedAction,
              policyAction: policy.action,
              policyReason: policy.reason,
            });
          }
          return { iteration: cycle.iteration + 1 };
        });
      }
      case 'FIXING': {
        const source = this.#fixSource(cycle);
        const known = source.kind === 'review' ? source.findings.map((finding) => finding.id) : [];
        const result = parseFixResult(rawResult, known);
        const next: NextStep =
          result.status === 'disputed'
            ? { state: 'NEEDS_HUMAN', reason: 'FIX_DISPUTED' }
            : result.status === 'needs_input'
              ? { state: 'NEEDS_HUMAN', reason: 'AGENT_NEEDS_INPUT' }
              : { state: 'VERIFYING' };
        return this.#record(cycle, run, JSON.stringify(result), next, () => undefined);
      }
    }
  }

  /**
   * Commits a stage's outcome if the cycle is still on that run; otherwise changes nothing.
   * Reviews and results can be far larger than the one row per b-tree the control reserve
   * holds, so this is an ordinary write.
   */
  #record(
    cycle: Cycle,
    run: AgentRun,
    resultJson: string | null,
    next: NextStep,
    persist: () => Partial<CyclePatch> | undefined,
  ): NextStep {
    const { store } = this.#deps;
    store.transaction(() => {
      const fresh = store.cycles.get(cycle.id);
      if (fresh?.currentRunId !== run.id || fresh.state !== cycle.state) return;
      if (resultJson !== null) store.runs.setResult(run.id, resultJson);
      const extra = persist() ?? {};
      const target = next.state as CycleState;
      assertTransition(fresh, target);
      store.cycles.update(
        cycle.id,
        {
          ...extra,
          state: target,
          reason: 'reason' in next ? next.reason : null,
          resumeStage: resumeStageFor(target, fresh.state as StageState),
          ...(target === 'FIXING' ? { autoFixRounds: fresh.autoFixRounds + 1 } : {}),
          ...(target === 'HUMAN_REVIEW_READY' ? { completedAt: nowIso(this.#deps) } : {}),
        },
        nowIso(this.#deps),
      );
    }, 'write');
    return next;
  }

  #stop(cycle: Cycle, runId: RunId, state: 'BLOCKED' | 'FAILED', reason: CycleReason): void {
    this.#commit(cycle.id, 'reserve', (fresh) =>
      fresh.currentRunId === runId && isStage(fresh.state)
        ? {
            state,
            reason,
            resumeStage: resumeStageFor(state, fresh.state),
            ...(state === 'FAILED' ? { completedAt: nowIso(this.#deps) } : {}),
          }
        : null,
    );
  }

  /** Applies `change` to the latest state inside a transaction; null from `change` means no-op. */
  #commit(
    cycleId: CycleId,
    mode: TransactionMode,
    change: (fresh: Cycle) => (CyclePatch & { state: CycleState }) | null,
  ): Cycle | null {
    const { store } = this.#deps;
    return store.transaction(() => {
      const fresh = store.cycles.get(cycleId);
      if (fresh === null) return null;
      const patch = change(fresh);
      if (patch === null) return null;
      assertTransition(fresh, patch.state);
      return store.cycles.update(cycleId, patch, nowIso(this.#deps));
    }, mode);
  }

  /**
   * Starts the agent for `stage`. Internal launches pass the same storage and recovery gates as
   * start_run. If the launch fails, the cycle is BLOCKED; a human-triggered launch also
   * rethrows the error.
   */
  async #launchOrBlock(cycle: Cycle, stage: StageState, rethrow: boolean): Promise<void> {
    try {
      if (this.#runs.recoveryStatus().state === 'incomplete') {
        throw recoveryIncompleteError(this.#runs.recoveryStatus(), 'cycle stage');
      }
      assertOperationAllowed(await this.#storage.assess(), 'agent_run');
      await this.#launch(cycle, stage);
    } catch (error) {
      this.#deps.logger.warn('cycle stage could not start', {
        cycleId: cycle.id,
        stage,
        code: isOrviaError(error) ? error.code : 'INTERNAL',
      });
      this.#commit(cycle.id, 'reserve', (fresh) =>
        fresh.state === stage
          ? { state: 'BLOCKED', reason: 'START_FAILED', resumeStage: stage }
          : null,
      );
      if (rethrow) {
        throw isOrviaError(error)
          ? new OrviaError(error.code, error.message, { ...error.details, cycleId: cycle.id })
          : error;
      }
    }
  }

  async #launch(cycle: Cycle, stage: StageState): Promise<void> {
    const purpose = PURPOSE[stage];
    await this.#runs.start({
      workItemId: cycle.workItemId,
      agent: stage === 'REVIEWING' ? cycle.reviewAgent : cycle.implementationAgent,
      instructions: this.#instructions(cycle, stage),
      purpose: purpose satisfies RunPurpose,
      cycleId: cycle.id,
      access: stage === 'REVIEWING' ? 'read-only' : 'edit',
      resultSchema: resultJsonSchema(purpose),
      // A pause or cancel may have landed while the launch was being prepared.
      withinTransaction: (run) => {
        const fresh = this.#deps.store.cycles.get(cycle.id);
        if (fresh?.state !== stage) {
          throw new OrviaError('INVALID_STATE_TRANSITION', `cycle ${cycle.id} left ${stage}`, {
            cycleId: cycle.id,
          });
        }
        this.#deps.store.cycles.update(cycle.id, { currentRunId: run.id }, nowIso(this.#deps));
      },
    });
  }

  #instructions(cycle: Cycle, stage: StageState): string {
    switch (stage) {
      case 'IMPLEMENTING':
        return implementationInstructions(cycle);
      case 'VERIFYING':
        return verificationInstructions();
      case 'REVIEWING':
        return reviewInstructions(cycle);
      case 'FIXING':
        return fixInstructions(this.#fixSource(cycle));
    }
  }

  /**
   * What the current fix addresses: the failed checks of the latest verification if that came
   * last, otherwise the routine findings of the latest review. Only findings the policy marked
   * AUTO_FIX are passed on; the reviewer's text never goes to the fix agent unfiltered.
   */
  #fixSource(
    cycle: Cycle,
  ):
    | { kind: 'review'; reviewId: string; findings: Finding[] }
    | { kind: 'verification'; result: VerificationResult } {
    const { store } = this.#deps;
    const latest = store.runs
      .listForCycle(cycle.id)
      .find((run) => run.purpose === 'verification' || run.purpose === 'review');
    if (latest?.purpose === 'verification' && latest.result !== null) {
      return { kind: 'verification', result: JSON.parse(latest.result) as VerificationResult };
    }
    const review = store.reviews.latestForCycle(cycle.id);
    if (review === null) {
      throw new OrviaError('INTERNAL', `cycle ${cycle.id} has nothing to fix`, {
        cycleId: cycle.id,
      });
    }
    return {
      kind: 'review',
      reviewId: review.id,
      findings: store.reviews
        .findings(review.id)
        .filter((finding) => finding.policyAction === 'AUTO_FIX'),
    };
  }

  #require(cycleId: CycleId): Cycle {
    const cycle = this.#deps.store.cycles.get(cycleId);
    if (cycle === null)
      throw new OrviaError('NOT_FOUND', `cycle ${cycleId} not found`, { cycleId });
    return cycle;
  }
}
