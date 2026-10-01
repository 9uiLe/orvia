import type { PlanId, WorkItemId } from '../domain/ids.ts';
import type { AgentRun } from '../domain/records.ts';
import type { StorageAssessment } from '../domain/storage.ts';
import type { WorkItemStatus } from '../domain/work-item.ts';
import type { Dependencies } from './dependencies.ts';
import type { StorageService } from './storage.ts';

export interface OpenWorkItemSummary {
  readonly id: WorkItemId;
  readonly planId: PlanId;
  readonly title: string;
  readonly status: WorkItemStatus;
  readonly branch: string | null;
  readonly worktreeRoot: string | null;
  readonly currentRun: Pick<AgentRun, 'id' | 'agent' | 'status' | 'startedAt'> | null;
}

export interface OverallStatus {
  readonly activePlans: number;
  readonly workItems: Record<WorkItemStatus, number>;
  readonly openWorkItems: OpenWorkItemSummary[];
  readonly runningRuns: number;
  readonly storage: StorageAssessment;
}

export async function getStatus(
  deps: Dependencies,
  storage: StorageService,
): Promise<OverallStatus> {
  const { store } = deps;
  const running = new Map(store.runs.listRunning().map((run) => [run.workItemId, run]));
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
          : { id: run.id, agent: run.agent, status: run.status, startedAt: run.startedAt },
    };
  });
  return {
    activePlans: store.plans.countByStatus().active,
    workItems: store.workItems.countByStatus(),
    openWorkItems,
    runningRuns: running.size,
    storage: await storage.assess(),
  };
}
