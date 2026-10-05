import { createHash } from 'node:crypto';
import type { Checkpoint, DesignRevision, ReviewAction, WorkReport } from '../domain/checkpoint.ts';
import { isOrviaError, OrviaError } from '../domain/errors.ts';
import type { CheckpointId, PlanId, WorkItemId } from '../domain/ids.ts';
import { assertPlanAcceptsChanges } from '../domain/plan.ts';
import type { AgentRun } from '../domain/records.ts';
import type { CodeSnapshot } from '../domain/repository-evidence.ts';
import { assertWorkItemCanRun, requireBoundWorkspace } from '../domain/work-item.ts';
import { assertWorkspaceMatches } from '../domain/workspace.ts';
import { assertCheckpointProfile, requireProfile } from './agent-profiles.ts';
import { parseWorkReport, resultJsonSchema, ResultProtocolError } from './agent-results.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import { composeAgentPrompt } from './prompt.ts';
import type { RunSupervisor, StageOutput } from './runs.ts';
import { requireWorkItem } from './work-items.ts';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class CheckpointSupervisor {
  readonly #deps: Dependencies;
  readonly #runs: RunSupervisor;

  constructor(deps: Dependencies, runs: RunSupervisor) {
    this.#deps = deps;
    this.#runs = runs;
    runs.onFinished((run, output) => this.#finish(run, output));
  }

  confirmDesign(input: {
    planId: PlanId;
    goal: string;
    scope: string;
    constraints: string;
    acceptanceCriteria: string;
  }): DesignRevision {
    return this.#deps.store.transaction(() => {
      assertPlanAcceptsChanges(requirePlan(this.#deps, input.planId));
      return this.#deps.store.designRevisions.insert({ ...input, now: nowIso(this.#deps) });
    });
  }

  #context(workItemId: WorkItemId) {
    const { store } = this.#deps;
    const item = requireWorkItem(this.#deps, workItemId);
    const plan = requirePlan(this.#deps, item.planId);
    const design = store.designRevisions.latest(plan.id);
    if (design === null) {
      throw new OrviaError(
        'DESIGN_NOT_CONFIRMED',
        'confirm the design in the app before preparing a prompt',
        {
          planId: plan.id,
        },
      );
    }
    const decisions = store.decisions
      .listForPlan(plan.id)
      .filter(
        (d) => d.status === 'accepted' && (d.workItemId === null || d.workItemId === item.id),
      );
    const notes = store.notes
      .listForPlan(plan.id)
      .filter((n) => n.workItemId === null || n.workItemId === item.id);
    const record = store.checkpoints.latestDispatched(item.id);
    const previous =
      record === null
        ? null
        : {
            id: record.id,
            baseCommit: record.baseCommit,
            state: record.state,
            runStatus: record.runStatus,
            report: record.report,
            reportError: record.reportError,
            reviews: record.reviews,
          };
    return { item, plan, design, decisions, notes, previous };
  }

  #assertCanPrepare(workItemId: WorkItemId): void {
    const { store } = this.#deps;
    this.#runs.assertAvailable(workItemId);
    const item = requireWorkItem(this.#deps, workItemId);
    assertWorkItemCanRun(item);
    assertPlanAcceptsChanges(requirePlan(this.#deps, item.planId));
    if (store.cycles.active(item.id) !== null) {
      throw new OrviaError('CYCLE_ACTIVE', 'cancel the legacy cycle before preparing a checkpoint');
    }
    if (store.runs.current(item.id) !== null) {
      throw new OrviaError('RUN_IN_PROGRESS', 'the Work Item already has a running agent');
    }
    const previous = store.checkpoints.latestDispatched(item.id);
    if (previous !== null) {
      const review = previous.reviews.at(-1);
      if (
        previous.state !== 'reviewed' ||
        review === undefined ||
        store.decisions.get(review.decisionId)?.status !== 'accepted'
      ) {
        throw new OrviaError(
          'HUMAN_REVIEW_REQUIRED',
          'record an evaluation and human decision before the next checkpoint',
          {
            checkpointId: previous.id,
          },
        );
      }
    }
  }

  async #profileHash(profileId: string): Promise<string> {
    const profile = requireProfile(this.#deps.profiles, profileId);
    assertCheckpointProfile(profile);
    const resolved = await this.#deps.launcher.resolveCommand(profile.command);
    if (resolved === null) {
      throw new OrviaError('AGENT_UNAVAILABLE', 'the checkpoint profile command is unavailable', {
        profileId,
      });
    }
    return hash({
      id: profile.id,
      adapter: profile.adapter.id,
      command: profile.command,
      resolved,
      capabilities: profile.capabilities,
    });
  }

  async prepare(input: {
    workItemId: WorkItemId;
    profileId: string;
    instructions: string;
    endCondition: string;
  }): Promise<Checkpoint> {
    this.#assertCanPrepare(input.workItemId);
    const context = this.#context(input.workItemId);
    const workspace = requireBoundWorkspace(context.item);
    const profileHash = await this.#profileHash(input.profileId);
    assertWorkspaceMatches(
      context.item.id,
      workspace,
      await this.#deps.git.observe(workspace.worktreeRoot),
    );
    const code = await this.#deps.git.snapshot(workspace.worktreeRoot);
    const prompt =
      composeAgentPrompt({
        ...context,
        workItem: context.item,
        workspace,
        instructions: input.instructions,
      }) +
      `\n## Confirmed design ${context.design.id} (revision ${context.design.revision})\n` +
      `Goal: ${context.design.goal}\nScope: ${context.design.scope}\nConstraints: ${context.design.constraints}\nAcceptance criteria: ${context.design.acceptanceCriteria}\n` +
      `\n## Checkpoint end condition\n${input.endCondition}\n` +
      (context.previous === null
        ? ''
        : `\n## Previous checkpoint ${context.previous.id}\nAgent-reported work: ${JSON.stringify(context.previous.report)}\nRun status: ${context.previous.runStatus}\nReport error: ${context.previous.reportError}\nApp evaluation and human decision: ${JSON.stringify(context.previous.reviews.at(-1))}\n`) +
      `\n## Work report\nWork autonomously within the confirmed scope, including tests and needed fixes. Stop at the end condition or when human input is needed. Return only JSON matching this schema. Report commands as your own reported checks, not proof supplied by Orvia. Put missing checks and unresolved work in unresolved.\n${JSON.stringify(resultJsonSchema('manual'))}\n`;
    return this.#deps.store.transaction(() => {
      this.#assertCanPrepare(input.workItemId);
      if (hash(this.#context(input.workItemId)) !== hash(context)) {
        throw new OrviaError(
          'PROMPT_STALE',
          'the design or human context changed during preparation; prepare again',
        );
      }
      return this.#deps.store.checkpoints.insert({
        ...input,
        designRevisionId: context.design.id,
        prompt,
        preparedContext: { workspace, code, contextHash: hash(context), profileHash },
        baseCommit: context.previous?.baseCommit ?? code.head,
        previousCheckpointId: context.previous?.id ?? null,
        now: nowIso(this.#deps),
      });
    });
  }

  require(id: CheckpointId): Checkpoint {
    const checkpoint = this.#deps.store.checkpoints.get(id);
    if (checkpoint === null) throw new OrviaError('NOT_FOUND', `checkpoint ${id} not found`);
    return checkpoint;
  }

  get(input: { checkpointId: CheckpointId }) {
    const checkpoint = this.require(input.checkpointId);
    const run = checkpoint.runId === null ? null : this.#deps.store.runs.get(checkpoint.runId);
    return {
      checkpoint,
      design: this.#deps.store.designRevisions.get(checkpoint.designRevisionId),
      run,
      recordingState:
        checkpoint.state !== 'running'
          ? 'recorded'
          : run?.status === 'running'
            ? 'pending'
            : 'incomplete',
      decisions: checkpoint.reviews.map((r) => this.#deps.store.decisions.get(r.decisionId)),
      verificationSource: 'agent_reported',
      changedFiles:
        checkpoint.endCode === null
          ? null
          : this.#changedFiles(checkpoint.preparedContext.code, checkpoint.endCode),
    };
  }

  #changedFiles(before: CodeSnapshot, after: CodeSnapshot): string[] {
    const old = new Map(before.files.map((f) => [f.path, f.fingerprint]));
    const next = new Map(after.files.map((f) => [f.path, f.fingerprint]));
    return [...new Set([...old.keys(), ...next.keys()])]
      .filter((path) => old.get(path) !== next.get(path))
      .sort();
  }

  async #validate(checkpoint: Checkpoint): Promise<void> {
    const profileHash = await this.#profileHash(checkpoint.profileId);
    const workspace = checkpoint.preparedContext.workspace;
    assertWorkspaceMatches(
      checkpoint.workItemId,
      workspace,
      await this.#deps.git.observe(workspace.worktreeRoot),
    );
    const code = await this.#deps.git.snapshot(workspace.worktreeRoot);
    if (
      code.fingerprint !== checkpoint.preparedContext.code.fingerprint ||
      profileHash !== checkpoint.preparedContext.profileHash
    ) {
      throw new OrviaError(
        'PROMPT_STALE',
        'code or Agent Profile changed; prepare the prompt again',
        { checkpointId: checkpoint.id },
      );
    }
    this.#validateRecords(checkpoint);
  }

  #validateRecords(checkpoint: Checkpoint): void {
    this.#assertCanPrepare(checkpoint.workItemId);
    if (hash(this.#context(checkpoint.workItemId)) !== checkpoint.preparedContext.contextHash) {
      throw new OrviaError(
        'PROMPT_STALE',
        'design, decisions, evaluation, or Work Item changed; prepare again',
        { checkpointId: checkpoint.id },
      );
    }
  }

  async dispatch(input: { checkpointId: CheckpointId }): Promise<AgentRun> {
    const checkpoint = this.require(input.checkpointId);
    const existing = checkpoint.runId === null ? null : this.#deps.store.runs.get(checkpoint.runId);
    if (checkpoint.state !== 'prepared') {
      if (existing !== null) return existing;
      throw new OrviaError('PROMPT_ALREADY_DISPATCHED', 'this prompt cannot be dispatched again', {
        checkpointId: checkpoint.id,
        state: checkpoint.state,
      });
    }
    try {
      await this.#validate(checkpoint);
      return await this.#runs.start({
        kind: 'manual',
        checkpointId: checkpoint.id,
        workItemId: checkpoint.workItemId,
        profileId: checkpoint.profileId,
        instructions: checkpoint.instructions,
        validate: () => this.#validate(checkpoint),
        validateRecords: () => {
          this.#validateRecords(checkpoint);
        },
      });
    } catch (error) {
      const current = this.require(checkpoint.id);
      if (current.state !== 'prepared' && current.runId !== null) {
        const run = this.#deps.store.runs.get(current.runId);
        if (
          run !== null &&
          isOrviaError(error) &&
          (error.code === 'RUN_IN_PROGRESS' ||
            error.code === 'PROMPT_ALREADY_DISPATCHED' ||
            error.code === 'HUMAN_REVIEW_REQUIRED')
        )
          return run;
      }
      throw error;
    }
  }

  discard(input: { checkpointId: CheckpointId }): Checkpoint {
    return this.#deps.store.transaction(() => {
      const checkpoint = this.require(input.checkpointId);
      if (checkpoint.state !== 'prepared')
        throw new OrviaError('INVALID_STATE_TRANSITION', 'only a prepared prompt can be discarded');
      return this.#deps.store.checkpoints.update(checkpoint.id, { state: 'discarded' });
    }, 'reserve');
  }

  review(input: {
    checkpointId: CheckpointId;
    evaluation: string;
    action: ReviewAction;
    decision: string;
  }): Checkpoint {
    return this.#deps.store.transaction(() => {
      const checkpoint = this.require(input.checkpointId);
      const item = requireWorkItem(this.#deps, checkpoint.workItemId);
      assertWorkItemCanRun(item);
      if (
        !['awaiting_review', 'reviewed'].includes(checkpoint.state) ||
        this.#deps.store.checkpoints.latestDispatched(item.id)?.id !== checkpoint.id ||
        this.#deps.store.runs.current(item.id) !== null
      ) {
        throw new OrviaError(
          'INVALID_STATE_TRANSITION',
          'review the latest finished checkpoint before continuing',
        );
      }
      const last = checkpoint.reviews.at(-1);
      const oldDecision =
        last === undefined ? null : this.#deps.store.decisions.get(last.decisionId);
      if (oldDecision?.status === 'accepted')
        this.#deps.store.decisions.markSuperseded(oldDecision.id);
      const now = nowIso(this.#deps);
      const decision = this.#deps.store.decisions.insert({
        planId: item.planId,
        workItemId: item.id,
        title: `${input.action} after ${checkpoint.id}`,
        body: input.decision,
        supersedesId: oldDecision?.id ?? null,
        now,
      });
      const updated = this.#deps.store.checkpoints.update(checkpoint.id, {
        state: 'reviewed',
        reviews: [
          ...checkpoint.reviews,
          {
            evaluation: input.evaluation,
            decisionId: decision.id,
            action: input.action,
            createdAt: now,
          },
        ],
      });
      if (input.action === 'complete')
        this.#deps.store.workItems.update(item.id, { status: 'completed' }, now);
      return updated;
    });
  }

  recover(): void {
    for (const checkpoint of this.#deps.store.checkpoints.listRunning()) {
      const run = checkpoint.runId === null ? null : this.#deps.store.runs.get(checkpoint.runId);
      if (run?.status === 'running') continue;
      this.#deps.store.transaction(
        () =>
          this.#deps.store.checkpoints.update(checkpoint.id, {
            state: 'awaiting_review',
            runStatus: run?.status ?? 'interrupted',
            reportError: 'RUN_INTERRUPTED_OR_REPORT_NOT_RECORDED',
            finishedAt: run?.finishedAt ?? nowIso(this.#deps),
          }),
        'reserve',
      );
    }
  }

  async #finish(run: AgentRun, output: StageOutput): Promise<void> {
    const checkpoint = this.#deps.store.checkpoints.findByRun(run.id);
    if (checkpoint === null) return;
    let report: WorkReport | null = null;
    let reportError: string | null = null;
    let endCode: CodeSnapshot | null = null;
    if (run.status !== 'succeeded') reportError = `RUN_${run.status.toUpperCase()}`;
    if (output.kind === 'result') {
      try {
        report = parseWorkReport(output.text);
      } catch (error) {
        if (!(error instanceof ResultProtocolError)) throw error;
        reportError = reportError ?? `RESULT_PROTOCOL_INVALID: ${error.problems.join('; ')}`;
      }
    } else reportError = reportError ?? `RESULT_${output.kind.toUpperCase()}`;
    try {
      const workspace = checkpoint.preparedContext.workspace;
      assertWorkspaceMatches(
        checkpoint.workItemId,
        workspace,
        await this.#deps.git.observe(workspace.worktreeRoot),
      );
      endCode = await this.#deps.git.snapshot(workspace.worktreeRoot);
    } catch {
      reportError = reportError ?? 'CODE_STATE_UNAVAILABLE';
    }
    try {
      this.#deps.store.transaction(() =>
        this.#deps.store.checkpoints.update(checkpoint.id, {
          state: 'awaiting_review',
          runStatus: run.status,
          report,
          reportError,
          endCode,
          finishedAt: run.finishedAt,
        }),
      );
    } catch (error) {
      if (!isOrviaError(error) || error.code !== 'STORAGE_HARD_LIMIT') throw error;
      this.#deps.store.transaction(
        () =>
          this.#deps.store.checkpoints.update(checkpoint.id, {
            state: 'awaiting_review',
            runStatus: run.status,
            reportError: 'REPORT_STORAGE_EXHAUSTED',
            finishedAt: run.finishedAt,
          }),
        'reserve',
      );
    }
  }

  async changes(input: {
    checkpointId: CheckpointId;
    maxBytes: number;
    expectedFingerprint?: string | undefined;
  }) {
    const checkpoint = this.require(input.checkpointId);
    const item = requireWorkItem(this.#deps, checkpoint.workItemId);
    const workspace = requireBoundWorkspace(item);
    assertWorkspaceMatches(
      item.id,
      checkpoint.preparedContext.workspace,
      await this.#deps.git.observe(workspace.worktreeRoot),
    );
    const evidence = await this.#deps.git.readChanges(
      workspace.worktreeRoot,
      checkpoint.baseCommit,
      input.maxBytes,
      input.expectedFingerprint,
    );
    return {
      ...evidence,
      checkpointId: checkpoint.id,
      matchesReport:
        checkpoint.endCode === null
          ? null
          : evidence.fingerprint === checkpoint.endCode.fingerprint,
    };
  }

  async source(input: {
    checkpointId: CheckpointId;
    path: string;
    offset: number;
    maxBytes: number;
    expectedFingerprint?: string | undefined;
  }) {
    const checkpoint = this.require(input.checkpointId);
    const item = requireWorkItem(this.#deps, checkpoint.workItemId);
    const workspace = requireBoundWorkspace(item);
    assertWorkspaceMatches(
      item.id,
      checkpoint.preparedContext.workspace,
      await this.#deps.git.observe(workspace.worktreeRoot),
    );
    const evidence = await this.#deps.git.readSource(
      workspace.worktreeRoot,
      input.path,
      input.offset,
      input.maxBytes,
      input.expectedFingerprint,
    );
    return {
      ...evidence,
      checkpointId: checkpoint.id,
      matchesReport:
        checkpoint.endCode === null
          ? null
          : evidence.fingerprint === checkpoint.endCode.fingerprint,
    };
  }
}
