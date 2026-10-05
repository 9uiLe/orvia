import { OrviaError } from '../domain/errors.ts';
import type { PlanId } from '../domain/ids.ts';
import { assertPlanAcceptsChanges, type Plan, type PlanStatus } from '../domain/plan.ts';
import type { Decision, Note } from '../domain/records.ts';
import type { DesignRevision } from '../domain/checkpoint.ts';
import { OPEN_STATUSES, type WorkItem } from '../domain/work-item.ts';
import { nowIso, type Dependencies } from './dependencies.ts';

export interface PlanDetails {
  readonly plan: Plan;
  readonly workItems: WorkItem[];
  readonly decisions: Decision[];
  readonly notes: Note[];
  readonly designRevisions: DesignRevision[];
}

export function requirePlan(deps: Dependencies, planId: PlanId): Plan {
  const plan = deps.store.plans.get(planId);
  if (plan === null) throw new OrviaError('NOT_FOUND', `plan ${planId} not found`, { planId });
  return plan;
}

export function createPlan(
  deps: Dependencies,
  input: { title: string; description?: string | undefined },
): Plan {
  return deps.store.transaction(() =>
    deps.store.plans.insert({
      title: input.title,
      description: input.description ?? '',
      now: nowIso(deps),
    }),
  );
}

export function getPlan(deps: Dependencies, input: { planId: PlanId }): PlanDetails {
  const plan = requirePlan(deps, input.planId);
  return {
    plan,
    workItems: deps.store.workItems.list({ planId: plan.id }),
    decisions: deps.store.decisions.listForPlan(plan.id),
    notes: deps.store.notes.listForPlan(plan.id),
    designRevisions: deps.store.designRevisions.listForPlan(plan.id),
  };
}

export function listPlans(deps: Dependencies, input: { status?: PlanStatus | undefined }): Plan[] {
  return deps.store.plans.list({ status: input.status ?? 'active' });
}

export function updatePlan(
  deps: Dependencies,
  input: { planId: PlanId; title?: string | undefined; description?: string | undefined },
): Plan {
  return deps.store.transaction(() => {
    assertPlanAcceptsChanges(requirePlan(deps, input.planId));
    return deps.store.plans.update(
      input.planId,
      {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      nowIso(deps),
    );
  });
}

export function archivePlan(deps: Dependencies, input: { planId: PlanId }): Plan {
  return deps.store.transaction(() => {
    const plan = requirePlan(deps, input.planId);
    assertPlanAcceptsChanges(plan);
    const open = deps.store.workItems.list({ planId: plan.id, statuses: OPEN_STATUSES });
    if (open.length > 0) {
      throw new OrviaError(
        'INVALID_STATE_TRANSITION',
        `plan ${plan.id} still has open work items; complete or archive them first`,
        { planId: plan.id, openWorkItemIds: open.map((item) => item.id) },
      );
    }
    return deps.store.plans.update(plan.id, { status: 'archived' }, nowIso(deps));
  }, 'reserve');
}
