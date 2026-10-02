import type { AgentCapability } from '../domain/agent-profile.ts';
import type { CycleId, DecisionId, PlanId, ReviewId, RunId, WorkItemId } from '../domain/ids.ts';
import type { Plan, PlanStatus } from '../domain/plan.ts';
import type {
  AgentRun,
  Decision,
  Note,
  NoteKind,
  RunPurpose,
  RunStatus,
} from '../domain/records.ts';
import type { Cycle, CycleMode, CycleReason, CycleState, StageState } from '../domain/cycle.ts';
import type { Finding, Review, ReviewVerdict } from '../domain/review.ts';
import type { FilesystemPolicy } from '../domain/sandbox.ts';
import type { DatabaseCapacity, DatabaseShape, DatabaseUsage } from '../domain/storage.ts';
import type { WorkItem, WorkItemStatus } from '../domain/work-item.ts';
import type { ObservedWorkspace, WorkspaceIdentity } from '../domain/workspace.ts';

/**
 * Transactions take a synchronous callback on purpose: an agent run or any other await
 * cannot happen while a write transaction is open.
 */
export type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * `write`: ordinary durable writes. `reserve`: control and maintenance (pause, recording a
 * run's result, cleanup, archive), which may also use the reserve kept for them.
 */
export type TransactionMode = 'write' | 'reserve';

export interface Store {
  transaction<T>(fn: () => SyncResult<T>, mode?: TransactionMode): T;
  readonly plans: PlanRepository;
  readonly workItems: WorkItemRepository;
  readonly runs: RunRepository;
  readonly decisions: DecisionRepository;
  readonly notes: NoteRepository;
  readonly cycles: CycleRepository;
  readonly reviews: ReviewRepository;
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
    profileId: string;
    outputRef: string;
    purpose: RunPurpose;
    cycleId: CycleId | null;
    now: string;
  }): AgentRun;
  /** Stores a validated, size-checked structured result. */
  setResult(id: RunId, resultJson: string): void;
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
  /** Newest first. */
  listForCycle(cycleId: CycleId): AgentRun[];
  listRunning(): AgentRun[];
  /** Returns false if the run was no longer running. */
  markInterrupted(id: RunId, now: string): boolean;
  /** Finished runs beyond the newest `keep` per Work Item. */
  listFinishedBeyond(keep: number): { runId: RunId; outputRef: string | null }[];
  delete(id: RunId): void;
  listOutputRefs(): string[];
}

export interface CyclePatch {
  state?: CycleState;
  reason?: CycleReason | null;
  resumeStage?: StageState | null;
  iteration?: number;
  autoFixRounds?: number;
  currentRunId?: RunId | null;
  completedAt?: string | null;
}

export interface CycleRepository {
  /** Throws CYCLE_ACTIVE when the Work Item already has an active cycle. */
  insert(input: {
    workItemId: WorkItemId;
    mode: CycleMode;
    state: StageState;
    maxAutoFixRounds: number;
    implementationProfileId: string;
    reviewProfileId: string;
    instructions: string;
    baseCommit: string;
    now: string;
  }): Cycle;
  get(id: CycleId): Cycle | null;
  active(workItemId: WorkItemId): Cycle | null;
  listActive(): Cycle[];
  update(id: CycleId, patch: CyclePatch, now: string): Cycle;
}

export interface ReviewRepository {
  insert(input: {
    cycleId: CycleId;
    runId: RunId | null;
    iteration: number;
    verdict: ReviewVerdict;
    summary: string;
    now: string;
  }): Review;
  insertFinding(input: Omit<Finding, 'id'>): Finding;
  get(id: ReviewId): Review | null;
  latestForCycle(cycleId: CycleId): Review | null;
  findings(reviewId: ReviewId): Finding[];
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
  shape(): DatabaseShape;
  capacity(): DatabaseCapacity;
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

export interface WriterOptions {
  /**
   * Bytes set aside from the shared cache budget when the writer is created; the writer uses
   * them before anything else and never more. Creating it fails with RESULT_STORAGE_EXHAUSTED
   * if they are not available.
   */
  readonly reserveBytes?: number;
}

export interface OutputWriter {
  write(chunk: Uint8Array): void;
  /** `truncated`: output beyond the budget or reservation was dropped; `failed`: a write error. */
  close(): Promise<{ bytes: number; truncated: boolean; failed: boolean }>;
}

/** Ephemeral, size-capped storage for agent output and other disposable data. */
export interface EphemeralStore {
  measureBytes(): Promise<number>;
  createWriter(ref: string, options?: WriterOptions): OutputWriter;
  readTail(ref: string, maxBytes: number): Promise<string | null>;
  /** The first `maxBytes` bytes of an entry, or null if it does not exist. */
  readHead(ref: string, maxBytes: number): Promise<string | null>;
  /** Absolute path of an entry, for agents that take a file argument. */
  absolutePath(ref: string): string;
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
  /** The commit `ref` names in the worktree, or null if it names none. */
  resolveCommit(worktreeRoot: string, ref: string): Promise<string | null>;
  /**
   * The worktree's changes against `baseCommit`: status (including untracked files) and the
   * diff of tracked files. Reads at most `maxBytes` of them; `complete` is false beyond that.
   */
  changes(worktreeRoot: string, baseCommit: string, maxBytes: number): Promise<ChangeEvidence>;
}

export interface ChangeEvidence {
  readonly baseCommit: string;
  readonly head: string | null;
  readonly status: string;
  readonly diff: string;
  readonly complete: boolean;
}

export interface AgentRunRequest {
  readonly policy: FilesystemPolicy;
  readonly prompt: string;
  /**
   * What this run may do. Adapters translate it into the CLI's own controls and grant nothing
   * beyond it, so a review without workspaceWrite cannot edit.
   */
  readonly capabilities: readonly AgentCapability[];
  /** Present when the run must end with a JSON result matching `schema`. */
  readonly result: { readonly schema: Record<string, unknown>; readonly schemaPath: string } | null;
}

export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}

/**
 * How to run one kind of agent CLI. Everything specific to a concrete CLI (flags, sandbox and
 * permission modes, the structured-output mechanism, output envelopes) lives behind this
 * interface and nowhere else.
 */
export interface AgentAdapter {
  /** Referenced by Agent Profiles in the configuration. */
  readonly id: string;
  readonly defaultCommand: string;
  /** What the adapter can make its CLI do; a profile can only narrow this. */
  readonly capabilities: readonly AgentCapability[];
  buildInvocation(command: string, request: AgentRunRequest): AgentInvocation;
  /** Largest stdout Orvia must keep to read a structured result of up to `resultBytes`. */
  resultStdoutBytes(resultBytes: number): number;
  /**
   * The structured result's JSON text from the agent's stdout, unwrapped from any
   * agent-specific envelope; null if the agent reported no result.
   */
  extractResult(stdout: string): string | null;
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly spawnError: string | null;
  /** Set when processes the agent left behind could not be confirmed stopped. */
  readonly leftoverError: string | null;
}

/**
 * An agent and every process it started. `exited` resolves once the agent has exited and its
 * remaining descendants have been stopped.
 */
export interface RunningProcess {
  readonly exited: Promise<ProcessExit>;
  /**
   * Stops the whole process tree and resolves only after it is confirmed gone.
   * Rejects with AGENT_TERMINATION_FAILED otherwise.
   */
  terminate(): Promise<void>;
}

export interface ProcessLauncher {
  resolveCommand(command: string): Promise<string | null>;
  launch(
    invocation: AgentInvocation,
    onOutput: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void,
  ): RunningProcess;
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
