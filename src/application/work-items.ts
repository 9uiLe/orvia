import { OrviaError } from '../domain/errors.ts';
import type { PlanId, WorkItemId } from '../domain/ids.ts';
import { assertPlanAcceptsChanges } from '../domain/plan.ts';
import type { AgentRun } from '../domain/records.ts';
import {
  assertWorkItemAcceptsChanges,
  transitionWorkItem,
  type WorkItem,
  type WorkItemStatus,
  type WorkItemTransition,
} from '../domain/work-item.ts';
import { identityFromObservation } from '../domain/workspace.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import type { TransactionMode, WorktreeEntry } from './ports.ts';

export interface WorkItemDetails {
  readonly workItem: WorkItem;
  readonly currentRun: AgentRun | null;
  readonly runs: AgentRun[];
}

export interface RunControl {
  pause<T>(workItemId: WorkItemId, commit: () => T): Promise<T>;
}

export function requireWorkItem(deps: Dependencies, workItemId: WorkItemId): WorkItem {
  const item = deps.store.workItems.get(workItemId);
  if (item === null) {
    throw new OrviaError('NOT_FOUND', `work item ${workItemId} not found`, { workItemId });
  }
  return item;
}

export function createWorkItem(
  deps: Dependencies,
  input: {
    planId: PlanId;
    title: string;
    description?: string | undefined;
    branch?: string | undefined;
    splitFromWorkItemId?: WorkItemId | undefined;
  },
): WorkItem {
  return deps.store.transaction(() => {
    assertPlanAcceptsChanges(requirePlan(deps, input.planId));
    if (input.splitFromWorkItemId !== undefined) {
      const source = requireWorkItem(deps, input.splitFromWorkItemId);
      if (source.planId !== input.planId) {
        throw new OrviaError(
          'VALIDATION_FAILED',
          `work item ${source.id} belongs to plan ${source.planId}, not ${input.planId}`,
          { splitFromWorkItemId: source.id, planId: input.planId },
        );
      }
    }
    return deps.store.workItems.insert({
      planId: input.planId,
      splitFromId: input.splitFromWorkItemId ?? null,
      title: input.title,
      description: input.description ?? '',
      branch: input.branch ?? null,
      now: nowIso(deps),
    });
  });
}

export function getWorkItem(
  deps: Dependencies,
  input: { workItemId: WorkItemId },
): WorkItemDetails {
  const workItem = requireWorkItem(deps, input.workItemId);
  return {
    workItem,
    currentRun: deps.store.runs.current(workItem.id),
    runs: deps.store.runs.listForWorkItem(workItem.id),
  };
}

export function listWorkItems(
  deps: Dependencies,
  input: { planId?: PlanId | undefined; statuses?: readonly WorkItemStatus[] | undefined },
): WorkItem[] {
  return deps.store.workItems.list({
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    statuses: input.statuses ?? ['active', 'paused'],
  });
}

export function updateWorkItem(
  deps: Dependencies,
  input: {
    workItemId: WorkItemId;
    title?: string | undefined;
    description?: string | undefined;
    prUrl?: string | null | undefined;
  },
): WorkItem {
  return deps.store.transaction(() => {
    assertWorkItemAcceptsChanges(requireWorkItem(deps, input.workItemId));
    return deps.store.workItems.update(
      input.workItemId,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
      },
      nowIso(deps),
    );
  });
}

/**
 * Binds a Work Item to the worktree at `worktreePath`. The recorded identity is what every
 * later Agent Run is validated against.
 */
export async function bindWorkspace(
  deps: Dependencies,
  input: { workItemId: WorkItemId; worktreePath: string },
): Promise<WorkItem> {
  const before = requireWorkItem(deps, input.workItemId);
  assertWorkItemAcceptsChanges(before);
  const observed = await deps.git.observe(input.worktreePath);
  if (observed === null) {
    throw new OrviaError('WORKSPACE_MISMATCH', 'path is not inside a git worktree', {
      worktreePath: input.worktreePath,
      reasons: ['worktree_missing'],
    });
  }
  const identity = identityFromObservation(observed, before.branch);
  return deps.store.transaction(() => {
    const item = requireWorkItem(deps, input.workItemId);
    assertWorkItemAcceptsChanges(item);
    if (deps.store.runs.current(item.id) !== null) {
      throw new OrviaError('RUN_IN_PROGRESS', `work item ${item.id} has a running agent`, {
        workItemId: item.id,
      });
    }
    return deps.store.workItems.update(
      item.id,
      { workspace: identity, branch: identity.branch },
      nowIso(deps),
    );
  });
}

/** Resume and archive are human controls that must work at HARD_LIMIT; completing is a write. */
function transactionModeFor(kind: Exclude<WorkItemTransition, 'pause'>): TransactionMode {
  return kind === 'complete' ? 'write' : 'reserve';
}

export function transition(
  deps: Dependencies,
  input: { workItemId: WorkItemId },
  kind: Exclude<WorkItemTransition, 'pause'>,
): WorkItem {
  return deps.store.transaction(() => {
    const item = requireWorkItem(deps, input.workItemId);
    const status = transitionWorkItem(item, kind);
    if (kind !== 'resume' && deps.store.runs.current(item.id) !== null) {
      throw new OrviaError(
        'RUN_IN_PROGRESS',
        `work item ${item.id} has a running agent; pause it first`,
        { workItemId: item.id },
      );
    }
    return deps.store.workItems.update(item.id, { status }, nowIso(deps));
  }, transactionModeFor(kind));
}

/** Returns once the Work Item's agent process tree has stopped and the Work Item is paused. */
export async function pauseWorkItem(
  deps: Dependencies,
  runs: RunControl,
  input: { workItemId: WorkItemId },
): Promise<WorkItem> {
  transitionWorkItem(requireWorkItem(deps, input.workItemId), 'pause');
  return runs.pause(input.workItemId, () =>
    deps.store.transaction(() => {
      const item = requireWorkItem(deps, input.workItemId);
      const status = transitionWorkItem(item, 'pause');
      return deps.store.workItems.update(item.id, { status }, nowIso(deps));
    }, 'reserve'),
  );
}

export interface DiscoveredWorktree extends WorktreeEntry {
  readonly boundWorkItemIds: WorkItemId[];
}

export async function discoverWorktrees(
  deps: Dependencies,
  input: { repositoryPath: string },
): Promise<DiscoveredWorktree[]> {
  const entries = await deps.git.listWorktrees(input.repositoryPath);
  const open = deps.store.workItems.list({ statuses: ['active', 'paused'] });
  return entries.map((entry) => ({
    ...entry,
    boundWorkItemIds: open
      .filter((item) => item.workspace?.worktreeRoot === entry.path)
      .map((item) => item.id),
  }));
}
