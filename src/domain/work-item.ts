import { OrviaError } from './errors.ts';
import type { PlanId, WorkItemId } from './ids.ts';
import type { WorkspaceIdentity } from './workspace.ts';

export const WORK_ITEM_STATUSES = ['active', 'paused', 'completed', 'archived'] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

/**
 * A unit of implementation: one branch, one worktree, one PR.
 * The workspace is bound explicitly; until then the Work Item cannot run agents.
 */
export interface WorkItem {
  readonly id: WorkItemId;
  readonly planId: PlanId;
  readonly splitFromId: WorkItemId | null;
  readonly title: string;
  readonly description: string;
  readonly status: WorkItemStatus;
  readonly branch: string | null;
  readonly workspace: WorkspaceIdentity | null;
  readonly prUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkItemTransition = 'pause' | 'resume' | 'complete' | 'archive';

const ALLOWED: Record<WorkItemTransition, readonly WorkItemStatus[]> = {
  pause: ['active'],
  resume: ['paused'],
  complete: ['active', 'paused'],
  archive: ['active', 'paused', 'completed'],
};

const TARGET: Record<WorkItemTransition, WorkItemStatus> = {
  pause: 'paused',
  resume: 'active',
  complete: 'completed',
  archive: 'archived',
};

export function transitionWorkItem(item: WorkItem, transition: WorkItemTransition): WorkItemStatus {
  if (!ALLOWED[transition].includes(item.status)) {
    throw new OrviaError(
      'INVALID_STATE_TRANSITION',
      `cannot ${transition} work item ${item.id} in status ${item.status}`,
      { workItemId: item.id, status: item.status, transition },
    );
  }
  return TARGET[transition];
}

export const OPEN_STATUSES: readonly WorkItemStatus[] = ['active', 'paused'];

export function isOpen(status: WorkItemStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function assertWorkItemCanRun(item: WorkItem): void {
  if (item.status !== 'active') {
    throw new OrviaError(
      'INVALID_STATE_TRANSITION',
      `work item ${item.id} is ${item.status}; only active work items can run`,
      { workItemId: item.id, status: item.status },
    );
  }
}

export function requireBoundWorkspace(item: WorkItem): WorkspaceIdentity {
  if (item.workspace === null) {
    throw new OrviaError('WORKSPACE_NOT_BOUND', `work item ${item.id} has no bound worktree`, {
      workItemId: item.id,
    });
  }
  return item.workspace;
}

export function assertWorkItemAcceptsChanges(item: WorkItem): void {
  if (!isOpen(item.status)) {
    throw new OrviaError('INVALID_STATE_TRANSITION', `work item ${item.id} is ${item.status}`, {
      workItemId: item.id,
      status: item.status,
    });
  }
}
