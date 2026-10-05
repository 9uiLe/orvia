import type {
  CheckpointId,
  DecisionId,
  DesignRevisionId,
  PlanId,
  RunId,
  WorkItemId,
} from './ids.ts';
import type { RunStatus } from './records.ts';
import type { CodeSnapshot } from './repository-evidence.ts';
import type { WorkspaceIdentity } from './workspace.ts';

export const CHECKPOINT_STATES = [
  'prepared',
  'running',
  'awaiting_review',
  'reviewed',
  'discarded',
] as const;
export type CheckpointState = (typeof CHECKPOINT_STATES)[number];
export const REVIEW_ACTIONS = ['continue', 'revise', 'complete'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface DesignRevision {
  readonly id: DesignRevisionId;
  readonly planId: PlanId;
  readonly revision: number;
  readonly goal: string;
  readonly scope: string;
  readonly constraints: string;
  readonly acceptanceCriteria: string;
  readonly confirmedAt: string;
}

export interface PreparedContext {
  readonly workspace: WorkspaceIdentity;
  readonly code: CodeSnapshot;
  readonly contextHash: string;
  readonly profileHash: string;
}

export interface WorkReport {
  readonly status: 'completed' | 'needs_input';
  readonly summary: string;
  readonly commands: readonly {
    readonly command: string;
    readonly exitCode: number | null;
    readonly summary: string;
  }[];
  readonly unresolved: string;
  readonly requiredDecision: string;
}

export interface CheckpointReview {
  readonly evaluation: string;
  readonly decisionId: DecisionId;
  readonly action: ReviewAction;
  readonly createdAt: string;
}

export interface Checkpoint {
  readonly id: CheckpointId;
  readonly workItemId: WorkItemId;
  readonly designRevisionId: DesignRevisionId;
  readonly profileId: string;
  readonly instructions: string;
  readonly endCondition: string;
  readonly prompt: string;
  readonly preparedContext: PreparedContext;
  readonly baseCommit: string;
  readonly previousCheckpointId: CheckpointId | null;
  readonly state: CheckpointState;
  readonly runId: RunId | null;
  readonly runStatus: RunStatus | null;
  readonly report: WorkReport | null;
  readonly reportError: string | null;
  readonly endCode: CodeSnapshot | null;
  readonly reviews: readonly CheckpointReview[];
  readonly preparedAt: string;
  readonly finishedAt: string | null;
}
