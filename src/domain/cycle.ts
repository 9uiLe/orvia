import { OrviaError } from './errors.ts';
import type { CycleId, RunId, WorkItemId } from './ids.ts';

/** Stages in which an agent of the cycle is running. */
export const STAGE_STATES = ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING'] as const;
export type StageState = (typeof STAGE_STATES)[number];

/** Waiting for a human (or for one to resume after a problem). */
export const WAITING_STATES = ['NEEDS_HUMAN', 'PAUSED', 'BLOCKED'] as const;

/** Automation has ended for this cycle; a new cycle may start for the Work Item. */
export const TERMINAL_STATES = ['HUMAN_REVIEW_READY', 'FAILED', 'CANCELLED'] as const;

export const CYCLE_STATES = [...STAGE_STATES, ...WAITING_STATES, ...TERMINAL_STATES] as const;
export type CycleState = (typeof CYCLE_STATES)[number];

/** Non-terminal states; at most one cycle per Work Item may be in one of these. */
export const ACTIVE_STATES = [...STAGE_STATES, ...WAITING_STATES] as const;

export const CYCLE_MODES = ['implement', 'review_existing'] as const;
export type CycleMode = (typeof CYCLE_MODES)[number];

/** Why a cycle is waiting, blocked, or ended. */
export const CYCLE_REASONS = [
  'DECISION_REQUIRED',
  'REVIEWER_REQUESTED_HUMAN',
  'AGENT_NEEDS_INPUT',
  'FIX_DISPUTED',
  'LOOP_LIMIT',
  'REVIEW_PROTOCOL_INVALID',
  'RESULT_PROTOCOL_INVALID',
  'RUN_FAILED',
  'RUN_INTERRUPTED',
  'VERIFICATION_BLOCKED',
  'START_FAILED',
  'AGENT_PROFILE_NOT_FOUND',
  'AGENT_CAPABILITY_MISMATCH',
  'AGENT_UNAVAILABLE',
  'RESULT_STORAGE_EXHAUSTED',
  'CHANGES_TOO_LARGE',
  'STORAGE_HARD_LIMIT',
  'PAUSED_BY_HUMAN',
  'CANCELLED_BY_HUMAN',
  'INTERNAL_ERROR',
] as const;
export type CycleReason = (typeof CYCLE_REASONS)[number];

/**
 * One automation session for a Work Item: implement → verify → review → fix → … until
 * HUMAN_REVIEW_READY, or a stop that needs a human. Separate from the Work Item's own
 * lifecycle (active/paused/completed/archived), which the human manages.
 */
export interface Cycle {
  readonly id: CycleId;
  readonly workItemId: WorkItemId;
  readonly mode: CycleMode;
  readonly state: CycleState;
  readonly reason: CycleReason | null;
  /** The stage to run again when a NEEDS_HUMAN, PAUSED, or BLOCKED cycle is resumed. */
  readonly resumeStage: StageState | null;
  /** Reviews completed in this cycle. */
  readonly iteration: number;
  /** Automatic fixes since the cycle started or a human last resumed it. */
  readonly autoFixRounds: number;
  readonly maxAutoFixRounds: number;
  readonly implementationProfileId: string;
  readonly reviewProfileId: string;
  readonly instructions: string;
  /** The commit the cycle's changes are reviewed against. */
  readonly baseCommit: string;
  readonly currentRunId: RunId | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

const ALWAYS = ['CANCELLED', 'FAILED'] as const;
const FROM_STAGE = ['PAUSED', 'BLOCKED', ...ALWAYS] as const;

/** Every allowed transition. Nothing else in the code base may change a cycle's state. */
const TRANSITIONS: Readonly<Record<CycleState, readonly CycleState[]>> = {
  IMPLEMENTING: ['VERIFYING', 'NEEDS_HUMAN', ...FROM_STAGE],
  VERIFYING: ['REVIEWING', 'FIXING', 'NEEDS_HUMAN', ...FROM_STAGE],
  REVIEWING: ['FIXING', 'NEEDS_HUMAN', 'HUMAN_REVIEW_READY', ...FROM_STAGE],
  FIXING: ['VERIFYING', 'NEEDS_HUMAN', ...FROM_STAGE],
  // See resumeStageAfterEscalation for which stage a human resume goes back to.
  NEEDS_HUMAN: ['IMPLEMENTING', 'VERIFYING', 'REVIEWING', ...ALWAYS],
  PAUSED: [...STAGE_STATES, ...ALWAYS],
  BLOCKED: [...STAGE_STATES, ...ALWAYS],
  HUMAN_REVIEW_READY: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: CycleState, to: CycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(cycle: Pick<Cycle, 'id' | 'state'>, to: CycleState): void {
  if (!canTransition(cycle.state, to)) {
    throw new OrviaError(
      'INVALID_STATE_TRANSITION',
      `cycle ${cycle.id} cannot go from ${cycle.state} to ${to}`,
      { cycleId: cycle.id, from: cycle.state, to },
    );
  }
}

export function isStage(state: CycleState): state is StageState {
  return (STAGE_STATES as readonly CycleState[]).includes(state);
}

export function isActive(state: CycleState): boolean {
  return (ACTIVE_STATES as readonly CycleState[]).includes(state);
}

/** The stage a cycle starts in. Both modes verify before reviewing: HUMAN_REVIEW_READY needs a passed verification. */
export function firstStage(mode: CycleMode): StageState {
  return mode === 'implement' ? 'IMPLEMENTING' : 'VERIFYING';
}

/**
 * Where a cycle that escalated from `stage` resumes after the human has decided. Normally the
 * review runs again with the latest decisions and context. A review only counts if the code it
 * sees has passed verification, so if the code may have changed since then (a fix stopped
 * partway) or verification kept failing, the cycle verifies again first. An implementation that
 * needed input resumes implementing.
 */
export function resumeStageAfterEscalation(stage: StageState): StageState {
  if (stage === 'IMPLEMENTING') return 'IMPLEMENTING';
  if (stage === 'REVIEWING') return 'REVIEWING';
  return 'VERIFYING';
}

/**
 * The complete state-dependent part of a cycle for entering `target`. Every transition builds
 * its patch here so `reason`, `resumeStage`, and `completedAt` always agree with `state`:
 * waiting states keep a stage to resume (`from`, the stage being left), terminal states are
 * completed and resume nothing, stage states carry neither a reason nor a resume stage.
 */
export function enterState(
  target: CycleState,
  entry: { reason?: CycleReason; from?: StageState; now: string },
): Pick<Cycle, 'state' | 'reason' | 'resumeStage' | 'completedAt'> {
  if (isStage(target)) {
    return { state: target, reason: null, resumeStage: null, completedAt: null };
  }
  if ((TERMINAL_STATES as readonly CycleState[]).includes(target)) {
    return {
      state: target,
      reason: entry.reason ?? null,
      resumeStage: null,
      completedAt: entry.now,
    };
  }
  if (entry.from === undefined) {
    throw new OrviaError('INTERNAL', `entering ${target} needs the stage being left`);
  }
  return {
    state: target,
    reason: entry.reason ?? null,
    resumeStage: target === 'NEEDS_HUMAN' ? resumeStageAfterEscalation(entry.from) : entry.from,
    completedAt: null,
  };
}

/** Where `resume_cycle` continues from. */
export function resumeTarget(cycle: Pick<Cycle, 'id' | 'state' | 'resumeStage'>): StageState {
  if (
    (cycle.state === 'NEEDS_HUMAN' || cycle.state === 'PAUSED' || cycle.state === 'BLOCKED') &&
    cycle.resumeStage !== null
  ) {
    return cycle.resumeStage;
  }
  throw new OrviaError(
    'INVALID_STATE_TRANSITION',
    `cycle ${cycle.id} is ${cycle.state}; nothing to resume`,
    {
      cycleId: cycle.id,
      state: cycle.state,
    },
  );
}
