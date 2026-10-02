import type { CycleId, FindingId, ReviewId, RunId } from './ids.ts';
import type { CycleReason, CycleState } from './cycle.ts';

export const REVIEW_VERDICTS = ['pass', 'findings', 'needs_human'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Problems an agent can fix without changing any decision a human owns. */
export const AUTO_FIX_CATEGORIES = [
  'correctness',
  'test',
  'build',
  'style',
  'decision_mismatch',
  'acceptance_mismatch',
] as const;

/** Questions only a human can answer. */
export const HUMAN_CATEGORIES = [
  'design',
  'scope',
  'acceptance_criteria',
  'public_api',
  'database_schema',
  'security',
  'dependency',
  'architecture',
  'decision_conflict',
  'ambiguous_requirement',
  'unknown',
] as const;

export const FINDING_CATEGORIES = [...AUTO_FIX_CATEGORIES, ...HUMAN_CATEGORIES] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Evidence {
  readonly path: string;
  readonly line: number | null;
  readonly message: string;
}

export const POLICY_ACTIONS = ['AUTO_FIX', 'NEEDS_HUMAN'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_REASONS = [
  'ROUTINE_FIX',
  'HUMAN_CATEGORY',
  'UNKNOWN_CATEGORY',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type PolicyReason = (typeof POLICY_REASONS)[number];

export interface Review {
  readonly id: ReviewId;
  readonly cycleId: CycleId;
  readonly runId: RunId | null;
  readonly iteration: number;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly createdAt: string;
}

export interface Finding {
  readonly id: FindingId;
  readonly reviewId: ReviewId;
  readonly category: FindingCategory;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly Evidence[];
  readonly suggestedAction: string | null;
  readonly policyAction: PolicyAction;
  readonly policyReason: PolicyReason;
}

/**
 * Orvia's decision for one finding. The reviewer's text is evidence, not a decision: only the
 * category and whether the finding points at concrete code count, and anything the reviewer
 * could not classify goes to a human.
 */
export function classifyFinding(finding: {
  readonly category: FindingCategory;
  readonly evidence: readonly Evidence[];
}): { action: PolicyAction; reason: PolicyReason } {
  if (finding.category === 'unknown') return { action: 'NEEDS_HUMAN', reason: 'UNKNOWN_CATEGORY' };
  if (!(AUTO_FIX_CATEGORIES as readonly string[]).includes(finding.category)) {
    return { action: 'NEEDS_HUMAN', reason: 'HUMAN_CATEGORY' };
  }
  if (!finding.evidence.some((item) => item.path.trim() !== '')) {
    return { action: 'NEEDS_HUMAN', reason: 'INSUFFICIENT_EVIDENCE' };
  }
  return { action: 'AUTO_FIX', reason: 'ROUTINE_FIX' };
}

export type NextStep =
  | {
      readonly state: Extract<
        CycleState,
        'HUMAN_REVIEW_READY' | 'FIXING' | 'REVIEWING' | 'VERIFYING'
      >;
    }
  | {
      readonly state: Extract<CycleState, 'NEEDS_HUMAN' | 'BLOCKED'>;
      readonly reason: CycleReason;
    };

interface LoopBudget {
  readonly autoFixRounds: number;
  readonly maxAutoFixRounds: number;
}

function fixOrStop(budget: LoopBudget): NextStep {
  return budget.autoFixRounds >= budget.maxAutoFixRounds
    ? { state: 'NEEDS_HUMAN', reason: 'LOOP_LIMIT' }
    : { state: 'FIXING' };
}

/** What follows a review, given the policy actions of its findings. */
export function nextAfterReview(
  review: { readonly verdict: ReviewVerdict; readonly actions: readonly PolicyAction[] },
  budget: LoopBudget,
): NextStep {
  if (review.verdict === 'needs_human') {
    return { state: 'NEEDS_HUMAN', reason: 'REVIEWER_REQUESTED_HUMAN' };
  }
  if (review.actions.includes('NEEDS_HUMAN')) {
    return { state: 'NEEDS_HUMAN', reason: 'DECISION_REQUIRED' };
  }
  if (review.verdict === 'pass' && review.actions.length === 0)
    return { state: 'HUMAN_REVIEW_READY' };
  return fixOrStop(budget);
}

export const VERIFICATION_STATUSES = ['passed', 'failed', 'blocked'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Failed checks are fixable; a verification that could not run needs someone to unblock it. */
export function nextAfterVerification(status: VerificationStatus, budget: LoopBudget): NextStep {
  if (status === 'passed') return { state: 'REVIEWING' };
  if (status === 'blocked') return { state: 'BLOCKED', reason: 'VERIFICATION_BLOCKED' };
  return fixOrStop(budget);
}
