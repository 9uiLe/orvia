import * as z from 'zod/v4';
import { OrviaError } from '../domain/errors.ts';
import { idPattern, type EntityKind, type IdByKind } from '../domain/ids.ts';
import { PLAN_STATUSES } from '../domain/plan.ts';
import { assertOperationAllowed, type OperationClass } from '../domain/storage.ts';
import { WORK_ITEM_STATUSES } from '../domain/work-item.ts';
import type { Application } from './application.ts';
import { archivePlan, createPlan, getPlan, listPlans, updatePlan } from './plans.ts';
import { addContext, recordDecision, submitFeedback } from './records.ts';
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
    handler: (app) => getStatus(app.deps, app.storage),
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
      "Start a coding agent in the Work Item's bound worktree. Orvia validates the workspace identity first and refuses with WORKSPACE_MISMATCH if it changed. Experimental.",
    operationClass: 'agent_run',
    input: z.object({
      workItemId: id('workItem', 'Work Item id'),
      agent: text('Agent adapter name, e.g. codex or claude'),
      instructions: text('What the agent should do in this run'),
    }),
    handler: (app, input) => app.runs.start(input),
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
      'Record a human decision. To change a decision, pass supersedesDecisionId; the old one is kept as superseded.',
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
  if (gated) assertOperationAllowed(await app.storage.assess(), operation.operationClass);
  const result = await operation.run(app, input);
  if (gated) app.scheduleCleanupIfNeeded();
  return result;
}
