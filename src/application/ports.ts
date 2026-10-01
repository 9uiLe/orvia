import type { DecisionId, PlanId, RunId, WorkItemId } from '../domain/ids.ts';
import type { Plan, PlanStatus } from '../domain/plan.ts';
import type { AgentRun, Decision, Note, NoteKind, RunStatus } from '../domain/records.ts';
import type { FilesystemPolicy } from '../domain/sandbox.ts';
import type { DatabaseUsage } from '../domain/storage.ts';
import type { WorkItem, WorkItemStatus } from '../domain/work-item.ts';
import type { ObservedWorkspace, WorkspaceIdentity } from '../domain/workspace.ts';

/**
 * Transactions take a synchronous callback on purpose: an agent run or any other await
 * cannot happen while a write transaction is open.
 */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface Store {
  transaction<T>(fn: () => SyncResult<T>): T;
  readonly plans: PlanRepository;
  readonly workItems: WorkItemRepository;
  readonly runs: RunRepository;
  readonly decisions: DecisionRepository;
  readonly notes: NoteRepository;
  readonly maintenance: DatabaseMaintenance;
}

export interface PlanRepository {
  insert(input: { title: string; description: string; now: string }): Plan;
  get(id: PlanId): Plan | null;
  list(filter: { status?: PlanStatus }): Plan[];
  update(
    id: PlanId,
    patch: { title?: string; description?: string; status?: PlanStatus },
    now: string,
  ): Plan;
  countByStatus(): Record<PlanStatus, number>;
}

export interface WorkItemPatch {
  title?: string;
  description?: string;
  status?: WorkItemStatus;
  branch?: string | null;
  prUrl?: string | null;
  workspace?: WorkspaceIdentity | null;
}

export interface WorkItemRepository {
  insert(input: {
    planId: PlanId;
    splitFromId: WorkItemId | null;
    title: string;
    description: string;
    branch: string | null;
    now: string;
  }): WorkItem;
  get(id: WorkItemId): WorkItem | null;
  list(filter: { planId?: PlanId; statuses?: readonly WorkItemStatus[] }): WorkItem[];
  /** Throws WORKSPACE_CONFLICT when another open Work Item already owns the worktree or branch. */
  update(id: WorkItemId, patch: WorkItemPatch, now: string): WorkItem;
  countByStatus(): Record<WorkItemStatus, number>;
}

export interface RunRepository {
  /** Throws RUN_IN_PROGRESS when the Work Item already has a running run. */
  insert(input: {
    workItemId: WorkItemId;
    agent: string;
    outputRef: string;
    now: string;
  }): AgentRun;
  finish(
    id: RunId,
    result: {
      status: Exclude<RunStatus, 'running'>;
      exitCode: number | null;
      outputBytes: number;
      outputTruncated: boolean;
      now: string;
    },
  ): AgentRun;
  get(id: RunId): AgentRun | null;
  current(workItemId: WorkItemId): AgentRun | null;
  listForWorkItem(workItemId: WorkItemId): AgentRun[];
  listRunning(): AgentRun[];
  markAllRunningInterrupted(now: string): RunId[];
  /** Deletes finished runs beyond `keep` per Work Item and returns their output refs. */
  pruneFinished(keep: number): { runIds: RunId[]; outputRefs: string[] };
  listOutputRefs(): string[];
}

export interface DecisionRepository {
  insert(input: {
    planId: PlanId;
    workItemId: WorkItemId | null;
    title: string;
    body: string;
    supersedesId: DecisionId | null;
    now: string;
  }): Decision;
  get(id: DecisionId): Decision | null;
  markSuperseded(id: DecisionId): void;
  listForPlan(planId: PlanId): Decision[];
}

export interface NoteRepository {
  insert(input: {
    planId: PlanId;
    workItemId: WorkItemId | null;
    kind: NoteKind;
    body: string;
    now: string;
  }): Note;
  listForPlan(planId: PlanId): Note[];
}

export interface CheckpointResult {
  readonly busy: boolean;
  readonly walPages: number;
  readonly checkpointedPages: number;
}

export interface SchemaStatus {
  readonly databaseVersion: number;
  readonly supportedVersion: number;
  readonly applied: readonly {
    version: number;
    name: string;
    checksum: string;
    appliedAt: string;
  }[];
}

export interface DatabaseMaintenance {
  checkpoint(): CheckpointResult;
  incrementalVacuum(): { freedPages: number };
  schemaStatus(): SchemaStatus;
}

export interface DatabaseFiles {
  measure(): Promise<DatabaseUsage>;
  pruneBackups(olderThan: Date): Promise<{ removed: string[]; failures: CleanupFailure[] }>;
}

export interface CleanupFailure {
  readonly target: string;
  readonly message: string;
}

export interface OutputWriter {
  write(chunk: Uint8Array): void;
  close(): Promise<{ bytes: number; truncated: boolean }>;
}

/** Ephemeral, size-capped storage for agent output and other disposable data. */
export interface EphemeralStore {
  measureBytes(): Promise<number>;
  createWriter(ref: string): OutputWriter;
  readTail(ref: string, maxBytes: number): Promise<string | null>;
  remove(refs: readonly string[]): Promise<CleanupFailure[]>;
  sweep(options: {
    expiresBefore: Date;
    targetBytes: number;
    protectedRefs: ReadonlySet<string>;
  }): Promise<{ removed: number; freedBytes: number; failures: CleanupFailure[] }>;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly bare: boolean;
}

export interface GitInspector {
  /** Returns null when the path does not exist or is not inside a git worktree. */
  observe(path: string): Promise<ObservedWorkspace | null>;
  listWorktrees(repositoryPath: string): Promise<WorktreeEntry[]>;
}

export interface AgentRunRequest {
  readonly policy: FilesystemPolicy;
  readonly prompt: string;
}

export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}

/** Agent-specific behaviour lives behind this interface and nowhere else. */
export interface AgentAdapter {
  readonly name: string;
  readonly command: string;
  buildInvocation(request: AgentRunRequest): AgentInvocation;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: string | null;
}

export interface RunningProcess {
  readonly exited: Promise<ProcessExit>;
  cancel(): void;
}

export interface ProcessLauncher {
  resolveCommand(command: string): Promise<string | null>;
  launch(invocation: AgentInvocation, onOutput: (chunk: Uint8Array) => void): RunningProcess;
}

export interface Clock {
  now(): Date;
}

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Log metadata only: ids, codes, counts. Never prompts, agent output, or file contents. */
export interface Logger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  trace(message: string, fields?: LogFields): void;
}
