import type { DecisionId, NoteId, PlanId, RunId, WorkItemId } from './ids.ts';

export const DECISION_STATUSES = ['accepted', 'superseded'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** A human decision. Changing a decision records a new one that supersedes the old. */
export interface Decision {
  readonly id: DecisionId;
  readonly planId: PlanId;
  readonly workItemId: WorkItemId | null;
  readonly title: string;
  readonly body: string;
  readonly status: DecisionStatus;
  readonly supersedesId: DecisionId | null;
  readonly createdAt: string;
}

export const NOTE_KINDS = ['context', 'comment', 'redirect', 'reject'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** Human-provided context or feedback. `context` may target a Plan; feedback targets a Work Item. */
export interface Note {
  readonly id: NoteId;
  readonly planId: PlanId;
  readonly workItemId: WorkItemId | null;
  readonly kind: NoteKind;
  readonly body: string;
  readonly createdAt: string;
}

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface AgentRun {
  readonly id: RunId;
  readonly workItemId: WorkItemId;
  readonly agent: string;
  readonly status: RunStatus;
  readonly exitCode: number | null;
  readonly outputRef: string | null;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}
