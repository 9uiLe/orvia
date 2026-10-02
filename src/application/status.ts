import type { Cycle } from '../domain/cycle.ts';
import type { PlanId, WorkItemId } from '../domain/ids.ts';
import type { AgentRun } from '../domain/records.ts';
import type { StorageAssessment } from '../domain/storage.ts';
import type { WorkItemStatus } from '../domain/work-item.ts';
import type { Dependencies } from './dependencies.ts';
import { RECOVERY_REMEDIATION, type RecoveryResult } from './runs.ts';
import type { StorageService } from './storage.ts';

export interface OpenWorkItemSummary {
  readonly id: WorkItemId;
  readonly planId: PlanId;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly branch: string | null;
  readonly worktreeRoot: string | null;
  readonly currentRun: Pick<AgentRun, 'id' | 'profileId' | 'status' | 'startedAt'> | null;
  /** The active orchestration cycle; details (findings, history) via get_cycle. */
  readonly cycle: Pick<Cycle, 'id' | 'state' | 'reason' | 'iteration' | 'currentRunId'> | null;
}

export interface OverallStatus {
  readonly activePlans: number;
  readonly workItems: Record<WorkItemStatus, number>;
  readonly openWorkItems: OpenWorkItemSummary[];
  readonly runningRuns: number;
  readonly storage: StorageAssessment;
  readonly recovery: RecoveryView;
}

export type RecoveryView =
  | { readonly state: 'complete'; readonly recoveredRuns: number }
  | {
      readonly state: 'incomplete';
      readonly recoveredRuns: number;
      readonly remainingRuns: number;
      readonly reason: 'STORAGE_HARD_LIMIT';
      readonly blockedOperations: string;
      readonly remediation: string;
    };

export function describeRecovery(recovery: RecoveryResult): RecoveryView {
  if (recovery.state === 'complete') {
    return { state: 'complete', recoveredRuns: recovery.recoveredRunIds.length };
  }
  return {
    state: 'incomplete',
    recoveredRuns: recovery.recoveredRunIds.length,
    remainingRuns: recovery.remainingRunIds.length,
    reason: recovery.reason,
    blockedOperations: 'start_run and other writes; pausing a Work Item whose run is unrecovered',
    remediation: RECOVERY_REMEDIATION,
  };
}

function summarizeCycle(cycle: Cycle | undefined): OpenWorkItemSummary['cycle'] {
  if (cycle === undefined) return null;
  const { id, state, reason, iteration, currentRunId } = cycle;
  return { id, state, reason, iteration, currentRunId };
}

export async function getStatus(
  deps: Dependencies,
  storage: StorageService,
  runs: { recoveryStatus(): RecoveryResult },
): Promise<OverallStatus> {
  const { store } = deps;
  const running = new Map(store.runs.listRunning().map((run) => [run.workItemId, run]));
  const cycles = new Map(store.cycles.listActive().map((cycle) => [cycle.workItemId, cycle]));
  const openWorkItems = store.workItems.list({ statuses: ['active', 'paused'] }).map((item) => {
    const run = running.get(item.id);
    return {
      id: item.id,
      planId: item.planId,
      title: item.title,
      status: item.status,
      branch: item.branch,
      worktreeRoot: item.workspace?.worktreeRoot ?? null,
      currentRun:
        run === undefined
          ? null
          : { id: run.id, profileId: run.profileId, status: run.status, startedAt: run.startedAt },
      cycle: summarizeCycle(cycles.get(item.id)),
    };
  });
  return {
    activePlans: store.plans.countByStatus().active,
    workItems: store.workItems.countByStatus(),
    openWorkItems,
    runningRuns: running.size,
    storage: await storage.assess(),
    recovery: describeRecovery(runs.recoveryStatus()),
  };
}
