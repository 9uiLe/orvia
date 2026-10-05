import { OrviaError } from '../domain/errors.ts';
import type { DecisionId, PlanId, WorkItemId } from '../domain/ids.ts';
import { assertPlanAcceptsChanges } from '../domain/plan.ts';
import type { Decision, Note, NoteKind } from '../domain/records.ts';
import { assertWorkItemAcceptsChanges } from '../domain/work-item.ts';
import { nowIso, type Dependencies } from './dependencies.ts';
import { requirePlan } from './plans.ts';
import { requireWorkItem } from './work-items.ts';

interface Target {
  readonly planId: PlanId;
  readonly workItemId: WorkItemId | null;
}

/** Resolves an explicit target. A Work Item implies its Plan; nothing is inferred from "current". */
function resolveTarget(
  deps: Dependencies,
  input: { planId?: PlanId | undefined; workItemId?: WorkItemId | undefined },
): Target {
  if (input.workItemId !== undefined) {
    const item = requireWorkItem(deps, input.workItemId);
    assertWorkItemAcceptsChanges(item);
    if (input.planId !== undefined && input.planId !== item.planId) {
      throw new OrviaError(
        'VALIDATION_FAILED',
        `work item ${item.id} belongs to plan ${item.planId}, not ${input.planId}`,
        { workItemId: item.id, planId: input.planId },
      );
    }
    assertPlanAcceptsChanges(requirePlan(deps, item.planId));
    return { planId: item.planId, workItemId: item.id };
  }
  if (input.planId !== undefined) {
    assertPlanAcceptsChanges(requirePlan(deps, input.planId));
    return { planId: input.planId, workItemId: null };
  }
  throw new OrviaError('VALIDATION_FAILED', 'planId or workItemId is required');
}

export function addContext(
  deps: Dependencies,
  input: { planId?: PlanId | undefined; workItemId?: WorkItemId | undefined; body: string },
): Note {
  return deps.store.transaction(() => {
    const target = resolveTarget(deps, input);
    return deps.store.notes.insert({
      ...target,
      kind: 'context',
      body: input.body,
      now: nowIso(deps),
    });
  });
}

export function submitFeedback(
  deps: Dependencies,
  input: { workItemId: WorkItemId; kind: Exclude<NoteKind, 'context'>; body: string },
): Note {
  return deps.store.transaction(() => {
    const target = resolveTarget(deps, { workItemId: input.workItemId });
    return deps.store.notes.insert({
      ...target,
      kind: input.kind,
      body: input.body,
      now: nowIso(deps),
    });
  });
}

export function recordDecision(
  deps: Dependencies,
  input: {
    planId?: PlanId | undefined;
    workItemId?: WorkItemId | undefined;
    title: string;
    body: string;
    supersedesDecisionId?: DecisionId | undefined;
  },
): Decision {
  return deps.store.transaction(() => {
    const target = resolveTarget(deps, input);
    let supersedesId: DecisionId | null = null;
    if (input.supersedesDecisionId !== undefined) {
      const previous = deps.store.decisions.get(input.supersedesDecisionId);
      if (previous === null) {
        throw new OrviaError('NOT_FOUND', `decision ${input.supersedesDecisionId} not found`, {
          decisionId: input.supersedesDecisionId,
        });
      }
      if (previous.planId !== target.planId) {
        throw new OrviaError(
          'VALIDATION_FAILED',
          `decision ${previous.id} belongs to plan ${previous.planId}, not ${target.planId}`,
          { decisionId: previous.id, planId: target.planId },
        );
      }
      if (previous.workItemId !== target.workItemId) {
        throw new OrviaError(
          'VALIDATION_FAILED',
          'a decision can only supersede a decision for the same Plan or Work Item target',
          { decisionId: previous.id, workItemId: target.workItemId },
        );
      }
      if (previous.status !== 'accepted') {
        throw new OrviaError(
          'INVALID_STATE_TRANSITION',
          `decision ${previous.id} was already superseded`,
          { decisionId: previous.id },
        );
      }
      deps.store.decisions.markSuperseded(previous.id);
      supersedesId = previous.id;
    }
    return deps.store.decisions.insert({
      ...target,
      title: input.title,
      body: input.body,
      supersedesId,
      now: nowIso(deps),
    });
  });
}
