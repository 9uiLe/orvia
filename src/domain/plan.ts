import { OrviaError } from './errors.ts';
import type { PlanId } from './ids.ts';

export const PLAN_STATUSES = ['active', 'archived'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** A logical change discussed with a human. Not tied to any branch, worktree, or PR. */
export interface Plan {
  readonly id: PlanId;
  readonly title: string;
  readonly description: string;
  readonly status: PlanStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assertPlanAcceptsChanges(plan: Plan): void {
  if (plan.status === 'archived') {
    throw new OrviaError('INVALID_STATE_TRANSITION', `plan ${plan.id} is archived`, {
      planId: plan.id,
    });
  }
}
