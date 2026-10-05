import * as z from 'zod/v4';
import { OrviaError } from '../domain/errors.ts';
import { idPattern, type EntityKind, type IdByKind } from '../domain/ids.ts';
import { describeProfiles } from './agent-profiles.ts';
import { CYCLE_MODES } from '../domain/cycle.ts';
import { REVIEW_ACTIONS } from '../domain/checkpoint.ts';
import { PLAN_STATUSES } from '../domain/plan.ts';
import type { OperationClass } from '../domain/storage.ts';
import { WORK_ITEM_STATUSES } from '../domain/work-item.ts';
import type { Application } from './application.ts';
import { archivePlan, createPlan, getPlan, listPlans, updatePlan } from './plans.ts';
import { addContext, recordDecision, submitFeedback } from './records.ts';
import { assertAgentWorkAllowed } from './runs.ts';
import { getStatus } from './status.ts';
import {
  bindWorkspace,
  createWorkItem,
  discoverWorktrees,
  getWorkItem,
  listWorkItems,
  pauseWorkItem,
  transition,
  updateWorkItem,
} from './work-items.ts';

/** One operation, exposed identically through the IPC API, the CLI, and MCP tools. */
export interface Operation {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly operationClass: OperationClass;
  readonly input: z.ZodObject;
  run(app: Application, input: unknown): Promise<unknown>;
}

function defineOperation<S extends z.ZodObject>(definition: {
  name: string;
  title: string;
  description: string;
  operationClass: OperationClass;
  input: S;
  handler: (app: Application, input: z.output<S>) => unknown;
}): Operation {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    operationClass: definition.operationClass,
    input: definition.input,
    async run(app, raw) {
      const parsed = definition.input.safeParse(raw ?? {});
      if (!parsed.success) {
        throw new OrviaError('VALIDATION_FAILED', z.prettifyError(parsed.error), {
          operation: definition.name,
        });
      }
      return await definition.handler(app, parsed.data);
    },
  };
}

const ID_EXAMPLE: Record<EntityKind, string> = {
  plan: 'P-1',
  workItem: 'W-1',
  run: 'R-1',
  decision: 'D-1',
  note: 'N-1',
  cycle: 'C-1',
  review: 'Rv-1',
  finding: 'F-1',
  designRevision: 'S-1',
  checkpoint: 'K-1',
};

function id<K extends EntityKind>(kind: K, description: string): z.ZodType<IdByKind[K]> {
  // The regex is the runtime check; the cast only narrows the static type to the branded id.
  return z
    .string()
    .regex(idPattern(kind))
    .describe(`${description} (e.g. ${ID_EXAMPLE[kind]})`) as unknown as z.ZodType<IdByKind[K]>;
}

const text = (description: string) => z.string().trim().min(1).describe(description);
const noInput = z.object({});

export const OPERATIONS: readonly Operation[] = [
  defineOperation({
    name: 'get_status',
    title: 'Get status',
    description:
      'Overview of open Work Items, running Agent Runs, and storage pressure. Start here to answer "what is happening now?".',
    operationClass: 'read',
    input: noInput,
    handler: (app) => getStatus(app.deps, app.storage, app.runs),
  }),
  defineOperation({
    name: 'create_plan',
    title: 'Create plan',
    description:
      'Create a Plan: a logical change discussed with the human. A Plan is not a branch or PR; add Work Items for implementation units.',
    operationClass: 'write',
    input: z.object({
      title: text('Short title of the Plan'),
      description: z.string().optional().describe('Goal and scope of the Plan'),
    }),
    handler: (app, input) => createPlan(app.deps, input),
  }),
  defineOperation({
    name: 'get_plan',
    title: 'Get plan',
    description: 'Get a Plan with its Work Items, decisions, and human notes.',
    operationClass: 'read',
    input: z.object({ planId: id('plan', 'Plan id') }),
    handler: (app, input) => getPlan(app.deps, input),
  }),
  defineOperation({
    name: 'list_plans',
    title: 'List plans',
    description: 'List Plans. Defaults to active Plans.',
    operationClass: 'read',
    input: z.object({ status: z.enum(PLAN_STATUSES).optional() }),
    handler: (app, input) => listPlans(app.deps, input),
  }),
  defineOperation({
    name: 'update_plan',
    title: 'Update plan',
    description: 'Change the title or description of an active Plan.',
    operationClass: 'write',
    input: z.object({
      planId: id('plan', 'Plan id'),
      title: text('New title').optional(),
      description: z.string().optional(),
    }),
    handler: (app, input) => updatePlan(app.deps, input),
  }),
  defineOperation({
    name: 'archive_plan',
    title: 'Archive plan',
    description: 'Archive a Plan that has no open Work Items. Archived data is kept.',
    operationClass: 'maintenance',
    input: z.object({ planId: id('plan', 'Plan id') }),
    handler: (app, input) => archivePlan(app.deps, input),
  }),
  defineOperation({
    name: 'create_work_item',
    title: 'Create work item',
    description:
      'Add a Work Item (one branch, one worktree, one PR) to a Plan. Use splitFromWorkItemId when splitting an existing Work Item into several PRs.',
    operationClass: 'write',
    input: z.object({
      planId: id('plan', 'Plan the Work Item belongs to'),
      title: text('Short title of the Work Item'),
      description: z.string().optional(),
      branch: text('Branch the Work Item will use').optional(),
      splitFromWorkItemId: id('workItem', 'Work Item this one was split from').optional(),
    }),
    handler: (app, input) => createWorkItem(app.deps, input),
  }),
  defineOperation({
    name: 'get_work_item',
    title: 'Get work item',
    description: 'Get a Work Item with its bound workspace, current run, and recent runs.',
    operationClass: 'read',
    input: z.object({ workItemId: id('workItem', 'Work Item id') }),
    handler: (app, input) => getWorkItem(app.deps, input),
  }),
  defineOperation({
    name: 'list_work_items',
    title: 'List work items',
    description: 'List Work Items, optionally for one Plan. Defaults to open (active and paused).',
    operationClass: 'read',
    input: z.object({
      planId: id('plan', 'Only Work Items of this Plan').optional(),
      statuses: z.array(z.enum(WORK_ITEM_STATUSES)).min(1).optional(),
    }),
    handler: (app, input) => listWorkItems(app.deps, input),
  }),
  defineOperation({
    name: 'update_work_item',
    title: 'Update work item',
    description: 'Change the title, description, or PR URL of an open Work Item.',
    operationClass: 'write',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      title: text('New title').optional(),
      description: z.string().optional(),
      prUrl: z.url().nullable().optional().describe('Pull request URL, or null to clear'),
    }),
    handler: (app, input) => updateWorkItem(app.deps, input),
  }),
  defineOperation({
    name: 'discover_worktrees',
    title: 'Discover worktrees',
    description:
      'List the git worktrees of a local repository and which open Work Items are bound to them. Read-only.',
    operationClass: 'read',
    input: z.object({ repositoryPath: text('Path inside the git repository') }),
    handler: (app, input) => discoverWorktrees(app.deps, input),
  }),
  defineOperation({
    name: 'bind_workspace',
    title: 'Bind workspace',
    description:
      'Bind a Work Item to an existing git worktree. Orvia records the repository, worktree, and branch identity and validates it before every Agent Run.',
    operationClass: 'write',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      worktreePath: text('Root path of the worktree to bind'),
    }),
    handler: (app, input) => bindWorkspace(app.deps, input),
  }),
  defineOperation({
    name: 'start_run',
    title: 'Start agent run',
    description:
      'Dispatch the exact prompt of a prepared checkpoint after human instruction. Use prepare_prompt and inspect the returned full prompt first. Requires an unchanged design, decisions, Profile, workspace, and code state. Repeating the same checkpoint never launches twice. Experimental.',
    operationClass: 'agent_run',
    input: z.strictObject({ checkpointId: id('checkpoint', 'Prepared checkpoint to send') }),
    handler: (app, input) => app.checkpoints.dispatch(input),
  }),
  defineOperation({
    name: 'confirm_design',
    title: 'Confirm design',
    description:
      'Record the design agreed with the human in the app as an immutable Plan revision. Changes create a new revision; existing runs keep their previous design. get_plan returns revision history.',
    operationClass: 'write',
    input: z.object({
      planId: id('plan', 'Plan id'),
      goal: text('Agreed goal'),
      scope: text('Agreed scope'),
      constraints: z.string().describe('Agreed constraints, or an empty string if none'),
      acceptanceCriteria: text('Agreed acceptance criteria'),
    }),
    handler: (app, input) => app.checkpoints.confirmDesign(input),
  }),
  defineOperation({
    name: 'prepare_prompt',
    title: 'Prepare checkpoint prompt',
    description:
      'Prepare and persist a full prompt for one checkpoint without launching a CLI. Requires a confirmed design and, after an earlier checkpoint, app evaluation plus human decision. Inspect the returned prompt and target before instructing start_run.',
    operationClass: 'write',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      profileId: text('Selected Agent Profile'),
      instructions: text('Instructions for this checkpoint'),
      endCondition: text('When the agent must stop and report back'),
    }),
    handler: (app, input) => app.checkpoints.prepare(input),
  }),
  defineOperation({
    name: 'get_checkpoint',
    title: 'Get checkpoint',
    description:
      'Read the durable prompt, design, report, per-checkpoint changed files, evaluations and human decisions. These survive normal run pruning and cache cleanup. Agent commands are agent-reported, not verified by Orvia.',
    operationClass: 'read',
    input: z.object({ checkpointId: id('checkpoint', 'Checkpoint id') }),
    handler: (app, input) => app.checkpoints.get(input),
  }),
  defineOperation({
    name: 'discard_prompt',
    title: 'Discard prepared prompt',
    description:
      'Mark an unsent prepared prompt as discarded. Its content remains readable; it can no longer be sent.',
    operationClass: 'control',
    input: z.object({ checkpointId: id('checkpoint', 'Prepared checkpoint id') }),
    handler: (app, input) => app.checkpoints.discard(input),
  }),
  defineOperation({
    name: 'record_checkpoint_review',
    title: 'Record app evaluation and human decision',
    description:
      'Record the app evaluation and the human decision on the latest finished checkpoint. continue/revise enables preparing the next prompt; complete explicitly completes the Work Item. Changing a review preserves earlier evaluations and supersedes its decision.',
    operationClass: 'write',
    input: z.object({
      checkpointId: id('checkpoint', 'Finished checkpoint id'),
      evaluation: text('Evaluation from the app'),
      action: z.enum(REVIEW_ACTIONS),
      decision: text('The human decision and its rationale'),
    }),
    handler: (app, input) => app.checkpoints.review(input),
  }),
  defineOperation({
    name: 'get_checkpoint_changes',
    title: 'Read checkpoint changes',
    description:
      'Read current cumulative changes from the Work Item baseline, including untracked content. Returns code fingerprint, observation time and completeness. matchesReport distinguishes current code from the recorded checkpoint end state. Incomplete results require source retrieval or a larger request.',
    operationClass: 'read',
    input: z.object({
      checkpointId: id('checkpoint', 'Checkpoint id'),
      maxBytes: z.int().positive().describe('Maximum bytes of diff content'),
      expectedFingerprint: text('Require this code state; changed state is rejected').optional(),
    }),
    handler: (app, input) => app.checkpoints.changes(input),
  }),
  defineOperation({
    name: 'get_checkpoint_source',
    title: 'Read checkpoint source',
    description:
      'Read a byte page from a file in the bound worktree, including untracked files. Use nextOffset and expectedFingerprint for subsequent pages. Binary content is base64 encoded. Returns current code, not a historical source snapshot; external paths are refused.',
    operationClass: 'read',
    input: z.object({
      checkpointId: id('checkpoint', 'Checkpoint id'),
      path: text('Path relative to the bound worktree'),
      offset: z.int().nonnegative().default(0).describe('Byte offset'),
      maxBytes: z.int().positive().describe('Maximum bytes to read'),
      expectedFingerprint: text('Require this code state across pages').optional(),
    }),
    handler: (app, input) => app.checkpoints.source(input),
  }),
  defineOperation({
    name: 'list_agent_profiles',
    title: 'List agent profiles',
    description:
      'The configured Agent Profiles: adapter, command availability, effective capabilities, and supported cycle stages; plus whether legacy cycles are enabled and their default profiles.',
    operationClass: 'read',
    input: z.object({}),
    handler: async (app) => ({
      legacyCyclesEnabled: app.deps.orchestration.enableLegacyCycles,
      profiles: await describeProfiles(app.deps.profiles, app.deps.launcher),
      defaults: {
        implementationProfileId: app.deps.orchestration.defaultImplementationProfile,
        reviewProfileId: app.deps.orchestration.defaultReviewProfile,
      },
    }),
  }),
  defineOperation({
    name: 'start_cycle',
    title: 'Start cycle',
    description:
      'Start a legacy automated cycle for a Work Item. Disabled by default: requires orchestration.enable_legacy_cycles=true, otherwise LEGACY_CYCLES_DISABLED. `implement` runs implement → verify → review; `review_existing` verifies and reviews existing changes. Routine findings are fixed automatically; human findings stop at NEEDS_HUMAN. Ends at HUMAN_REVIEW_READY. One active cycle per Work Item. Experimental compatibility feature.',
    operationClass: 'agent_run',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      mode: z.enum(CYCLE_MODES),
      instructions: text('What the change should achieve'),
      implementationProfileId: text(
        'Agent Profile for implementing, verifying, and fixing; defaults to orchestration.default_implementation_profile',
      ).optional(),
      reviewProfileId: text(
        'Agent Profile for reviewing; defaults to orchestration.default_review_profile',
      ).optional(),
      baseRef: text(
        'Commit or ref the changes are reviewed against; defaults to HEAD when the cycle starts',
      ).optional(),
    }),
    handler: (app, input) => app.cycles.start(input),
  }),
  defineOperation({
    name: 'get_cycle',
    title: 'Get cycle',
    description:
      'A cycle with its state, the reason it is waiting (if any), its runs, the latest review, and the ids of findings that need a human decision.',
    operationClass: 'read',
    input: z.object({ cycleId: id('cycle', 'Cycle id') }),
    handler: (app, input) => app.cycles.get(input),
  }),
  defineOperation({
    name: 'get_current_review',
    title: 'Get current review',
    description: "The cycle's latest review and its findings, each with Orvia's policy action.",
    operationClass: 'read',
    input: z.object({ cycleId: id('cycle', 'Cycle id') }),
    handler: (app, input) => app.cycles.currentReview(input),
  }),
  defineOperation({
    name: 'get_review',
    title: 'Get review',
    description: 'Any review by id, with its findings; earlier reviews are kept for history.',
    operationClass: 'read',
    input: z.object({ reviewId: id('review', 'Review id') }),
    handler: (app, input) => app.cycles.review(input),
  }),
  defineOperation({
    name: 'pause_cycle',
    title: 'Pause cycle',
    description:
      "Pause a cycle. Returns after the running agent's whole process tree has stopped; fails with AGENT_TERMINATION_FAILED otherwise and the cycle keeps running.",
    operationClass: 'control',
    input: z.object({ cycleId: id('cycle', 'Cycle id') }),
    handler: (app, input) => app.cycles.pause(input),
  }),
  defineOperation({
    name: 'resume_cycle',
    title: 'Resume cycle',
    description:
      'Resume a legacy PAUSED, BLOCKED, or NEEDS_HUMAN cycle. Disabled by default: requires orchestration.enable_legacy_cycles=true, otherwise LEGACY_CYCLES_DISABLED. Record decisions or context first; the next stage uses the latest ones. After NEEDS_HUMAN the cycle reviews again, or verifies first if the code may have changed.',
    operationClass: 'agent_run',
    input: z.object({ cycleId: id('cycle', 'Cycle id') }),
    handler: (app, input) => app.cycles.resume(input),
  }),
  defineOperation({
    name: 'cancel_cycle',
    title: 'Cancel cycle',
    description:
      'End a cycle. A running agent is stopped first. The Work Item and its worktree are left as they are.',
    operationClass: 'control',
    input: z.object({ cycleId: id('cycle', 'Cycle id') }),
    handler: (app, input) => app.cycles.cancel(input),
  }),
  defineOperation({
    name: 'get_run_output',
    title: 'Get run output',
    description: "Read the last bytes of an Agent Run's output, if it is still in the cache.",
    operationClass: 'read',
    input: z.object({
      runId: id('run', 'Run id'),
      maxBytes: z.int().positive().describe('Maximum number of bytes to return from the end'),
    }),
    handler: (app, input) => app.runs.readOutput(input),
  }),
  defineOperation({
    name: 'pause_work_item',
    title: 'Pause work item',
    description:
      'Pause a Work Item. Returns after its running agent and every process the agent started have stopped; if they cannot be stopped, fails with AGENT_TERMINATION_FAILED and the Work Item stays active.',
    operationClass: 'control',
    input: z.object({ workItemId: id('workItem', 'Work Item id') }),
    handler: (app, input) => pauseWorkItem(app.deps, app.runs, input),
  }),
  defineOperation({
    name: 'resume_work_item',
    title: 'Resume work item',
    description: 'Resume a paused Work Item so that runs can start again.',
    operationClass: 'control',
    input: z.object({ workItemId: id('workItem', 'Work Item id') }),
    handler: (app, input) => transition(app.deps, input, 'resume'),
  }),
  defineOperation({
    name: 'complete_work_item',
    title: 'Complete work item',
    description: 'Mark a Work Item as completed. Fails while an agent is running.',
    operationClass: 'write',
    input: z.object({ workItemId: id('workItem', 'Work Item id') }),
    handler: (app, input) => transition(app.deps, input, 'complete'),
  }),
  defineOperation({
    name: 'archive_work_item',
    title: 'Archive work item',
    description: 'Archive a Work Item. Archived data is kept. Fails while an agent is running.',
    operationClass: 'maintenance',
    input: z.object({ workItemId: id('workItem', 'Work Item id') }),
    handler: (app, input) => transition(app.deps, input, 'archive'),
  }),
  defineOperation({
    name: 'add_context',
    title: 'Add context',
    description:
      'Record human context for a Plan or a Work Item. It is included in later agent prompts.',
    operationClass: 'write',
    input: z.object({
      planId: id('plan', 'Plan id (when the context applies to the whole Plan)').optional(),
      workItemId: id('workItem', 'Work Item id').optional(),
      body: text('The context'),
    }),
    handler: (app, input) => addContext(app.deps, input),
  }),
  defineOperation({
    name: 'record_decision',
    title: 'Record decision',
    description:
      'Record a human decision. To change a decision for the same Plan or Work Item target, pass supersedesDecisionId; the old one is kept as superseded.',
    operationClass: 'write',
    input: z.object({
      planId: id('plan', 'Plan id').optional(),
      workItemId: id('workItem', 'Work Item id when the decision is specific to it').optional(),
      title: text('Short statement of the decision'),
      body: text('Rationale and details'),
      supersedesDecisionId: id('decision', 'Decision this one replaces').optional(),
    }),
    handler: (app, input) => recordDecision(app.deps, input),
  }),
  defineOperation({
    name: 'submit_feedback',
    title: 'Submit feedback',
    description:
      'Record human feedback on a Work Item: comment, redirect (change direction), or reject (the current approach is not acceptable). It is included in later agent prompts.',
    operationClass: 'write',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      kind: z.enum(['comment', 'redirect', 'reject']),
      body: text('The feedback'),
    }),
    handler: (app, input) => submitFeedback(app.deps, input),
  }),
  defineOperation({
    name: 'get_storage_status',
    title: 'Get storage status',
    description: 'Storage usage, limits, and pressure level for the database and cache.',
    operationClass: 'read',
    input: noInput,
    handler: (app) => app.storage.status(),
  }),
  defineOperation({
    name: 'run_storage_cleanup',
    title: 'Run storage cleanup',
    description:
      'Prune old run records, evict expired or excess cache, remove old migration backups, and compact the database. Never touches git repositories.',
    operationClass: 'maintenance',
    input: noInput,
    handler: (app) => app.storage.cleanup(),
  }),
  defineOperation({
    name: 'get_schema_status',
    title: 'Get schema status',
    description: 'Database schema version supported by this Orvia build and applied migrations.',
    operationClass: 'read',
    input: noInput,
    handler: (app) => app.deps.store.maintenance.schemaStatus(),
  }),
];

const BY_NAME = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

export function findOperation(name: string): Operation {
  const operation = BY_NAME.get(name);
  if (operation === undefined) {
    throw new OrviaError('NOT_FOUND', `unknown operation ${name}`, { operation: name });
  }
  return operation;
}

export async function invokeOperation(
  app: Application,
  name: string,
  input: unknown,
): Promise<unknown> {
  const operation = findOperation(name);
  const gated = operation.operationClass === 'write' || operation.operationClass === 'agent_run';
  // While startup recovery is incomplete the daemon only serves inspection, controls, and
  // maintenance; new work would build on run records that still claim to be running.
  if (gated) {
    await assertAgentWorkAllowed(app.runs, app.storage, operation.name, operation.operationClass);
  }
  const result = await operation.run(app, input);
  if (gated) app.scheduleCleanupIfNeeded();
  return result;
}
