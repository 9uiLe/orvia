import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type {
  CyclePatch,
  CycleRepository,
  DatabaseMaintenance,
  ReviewRepository,
  DecisionRepository,
  NoteRepository,
  PlanRepository,
  RunRepository,
  SchemaStatus,
  Store,
  SyncResult,
  TransactionMode,
  WorkItemPatch,
  WorkItemRepository,
} from '../../application/ports.ts';
import { OrviaError } from '../../domain/errors.ts';
import {
  formatId,
  parseId,
  type DecisionId,
  type PlanId,
  type CycleId,
  type ReviewId,
  type RunId,
  type WorkItemId,
} from '../../domain/ids.ts';
import { PLAN_STATUSES, type Plan, type PlanStatus } from '../../domain/plan.ts';
import {
  databaseCapacity,
  type DatabaseCapacity,
  type DatabaseShape,
} from '../../domain/storage.ts';
import type {
  AgentRun,
  Decision,
  Note,
  NoteKind,
  RunPurpose,
  RunStatus,
} from '../../domain/records.ts';
import type { Cycle, CycleMode, CycleReason, CycleState, StageState } from '../../domain/cycle.ts';
import type {
  Evidence,
  Finding,
  FindingCategory,
  PolicyAction,
  PolicyReason,
  Review,
  ReviewVerdict,
} from '../../domain/review.ts';
import { WORK_ITEM_STATUSES, type WorkItem, type WorkItemStatus } from '../../domain/work-item.ts';
import { isUniqueViolation, translateSqliteError } from './database.ts';
import {
  countSchemaBtrees,
  latestVersion,
  readHeader,
  readHistory,
  type Migration,
} from './migrator.ts';
import { READ_QUERIES, WRITE_STATEMENTS } from './queries.ts';

type Row = Record<string, unknown>;

function str(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new OrviaError('INTERNAL', `column ${column} is not text`);
  return value;
}

function strOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  return str(row, column);
}

function num(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number')
    throw new OrviaError('INTERNAL', `column ${column} is not a number`);
  return value;
}

function numOrNull(row: Row, column: string): number | null {
  return row[column] === null ? null : num(row, column);
}

function rowToPlan(row: Row): Plan {
  return {
    id: formatId('plan', num(row, 'id')),
    title: str(row, 'title'),
    description: str(row, 'description'),
    status: str(row, 'status') as PlanStatus,
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function rowToWorkItem(row: Row): WorkItem {
  const root = strOrNull(row, 'worktree_root');
  const splitFrom = numOrNull(row, 'split_from_id');
  return {
    id: formatId('workItem', num(row, 'id')),
    planId: formatId('plan', num(row, 'plan_id')),
    splitFromId: splitFrom === null ? null : formatId('workItem', splitFrom),
    title: str(row, 'title'),
    description: str(row, 'description'),
    status: str(row, 'status') as WorkItemStatus,
    branch: strOrNull(row, 'branch'),
    workspace:
      root === null
        ? null
        : {
            repositoryCommonDir: str(row, 'repository_common_dir'),
            repositoryCommonDirFileId: str(row, 'repository_common_dir_file_id'),
            worktreeGitDir: str(row, 'worktree_git_dir'),
            worktreeGitDirFileId: str(row, 'worktree_git_dir_file_id'),
            worktreeRoot: root,
            branch: str(row, 'branch'),
          },
    prUrl: strOrNull(row, 'pr_url'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

function rowToRun(row: Row): AgentRun {
  const cycle = numOrNull(row, 'cycle_id');
  return {
    id: formatId('run', num(row, 'id')),
    workItemId: formatId('workItem', num(row, 'work_item_id')),
    cycleId: cycle === null ? null : formatId('cycle', cycle),
    purpose: str(row, 'purpose') as RunPurpose,
    profileId: str(row, 'profile_id'),
    status: str(row, 'status') as RunStatus,
    exitCode: numOrNull(row, 'exit_code'),
    outputRef: strOrNull(row, 'output_ref'),
    outputBytes: num(row, 'output_bytes'),
    outputTruncated: num(row, 'output_truncated') === 1,
    result: strOrNull(row, 'result'),
    startedAt: str(row, 'started_at'),
    finishedAt: strOrNull(row, 'finished_at'),
  };
}

function rowToCycle(row: Row): Cycle {
  const currentRun = numOrNull(row, 'current_run_id');
  return {
    id: formatId('cycle', num(row, 'id')),
    workItemId: formatId('workItem', num(row, 'work_item_id')),
    mode: str(row, 'mode') as CycleMode,
    state: str(row, 'state') as CycleState,
    reason: strOrNull(row, 'reason') as CycleReason | null,
    resumeStage: strOrNull(row, 'resume_stage') as StageState | null,
    iteration: num(row, 'iteration'),
    autoFixRounds: num(row, 'auto_fix_rounds'),
    maxAutoFixRounds: num(row, 'max_auto_fix_rounds'),
    implementationProfileId: str(row, 'implementation_profile'),
    reviewProfileId: str(row, 'review_profile'),
    instructions: str(row, 'instructions'),
    baseCommit: str(row, 'base_commit'),
    currentRunId: currentRun === null ? null : formatId('run', currentRun),
    startedAt: str(row, 'started_at'),
    updatedAt: str(row, 'updated_at'),
    completedAt: strOrNull(row, 'completed_at'),
  };
}

function rowToReview(row: Row): Review {
  const runId = numOrNull(row, 'run_id');
  return {
    id: formatId('review', num(row, 'id')),
    cycleId: formatId('cycle', num(row, 'cycle_id')),
    runId: runId === null ? null : formatId('run', runId),
    iteration: num(row, 'iteration'),
    verdict: str(row, 'verdict') as ReviewVerdict,
    summary: str(row, 'summary'),
    createdAt: str(row, 'created_at'),
  };
}

function rowToFinding(row: Row): Finding {
  return {
    id: formatId('finding', num(row, 'id')),
    reviewId: formatId('review', num(row, 'review_id')),
    category: str(row, 'category') as FindingCategory,
    title: str(row, 'title'),
    detail: str(row, 'detail'),
    evidence: JSON.parse(str(row, 'evidence')) as Evidence[],
    suggestedAction: strOrNull(row, 'suggested_action'),
    policyAction: str(row, 'policy_action') as PolicyAction,
    policyReason: str(row, 'policy_reason') as PolicyReason,
  };
}

function rowToDecision(row: Row): Decision {
  const workItem = numOrNull(row, 'work_item_id');
  const supersedes = numOrNull(row, 'supersedes_id');
  return {
    id: formatId('decision', num(row, 'id')),
    planId: formatId('plan', num(row, 'plan_id')),
    workItemId: workItem === null ? null : formatId('workItem', workItem),
    title: str(row, 'title'),
    body: str(row, 'body'),
    status: str(row, 'status') as Decision['status'],
    supersedesId: supersedes === null ? null : formatId('decision', supersedes),
    createdAt: str(row, 'created_at'),
  };
}

function rowToNote(row: Row): Note {
  const workItem = numOrNull(row, 'work_item_id');
  return {
    id: formatId('note', num(row, 'id')),
    planId: formatId('plan', num(row, 'plan_id')),
    workItemId: workItem === null ? null : formatId('workItem', workItem),
    kind: str(row, 'kind') as NoteKind,
    body: str(row, 'body'),
    createdAt: str(row, 'created_at'),
  };
}

function countsFrom<S extends string>(rows: Row[], statuses: readonly S[]): Record<S, number> {
  const counts = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<S, number>;
  for (const row of rows) counts[str(row, 'status') as S] = num(row, 'n');
  return counts;
}

export interface StoreBudget {
  /** `storage.database_max_mb` in bytes. */
  readonly budgetBytes: number;
  /** Current size of every budgeted file other than the main database: WAL, SHM, any leftover journal, and backups. */
  readonly fixedBytes: () => number;
}

/** All SQL lives in this module and queries.ts; the application sees only the Store port. */
export class SqliteStore implements Store {
  readonly plans: PlanRepository;
  readonly workItems: WorkItemRepository;
  readonly runs: RunRepository;
  readonly decisions: DecisionRepository;
  readonly notes: NoteRepository;
  readonly cycles: CycleRepository;
  readonly reviews: ReviewRepository;
  readonly maintenance: DatabaseMaintenance;
  readonly #db: DatabaseSync;
  readonly #budget: StoreBudget;
  readonly #statements = new Map<string, StatementSync>();
  #btreeCount: number | undefined;

  constructor(db: DatabaseSync, migrations: readonly Migration[], budget: StoreBudget) {
    this.#db = db;
    this.#budget = budget;
    const one = (sql: string, ...params: SQLInputValue[]): Row | undefined =>
      this.#prepare(sql).get(...params);
    const all = (sql: string, ...params: SQLInputValue[]): Row[] =>
      this.#prepare(sql).all(...params);
    const run = (sql: string, ...params: SQLInputValue[]) => this.#prepare(sql).run(...params);
    const q = READ_QUERIES;
    const w = WRITE_STATEMENTS;

    const getPlan = (id: PlanId): Plan | null => {
      const row = one(q.getPlan, parseId('plan', id));
      return row === undefined ? null : rowToPlan(row);
    };
    const mustGet = <T>(value: T | null, what: string): T => {
      if (value === null) throw new OrviaError('NOT_FOUND', `${what} not found`);
      return value;
    };
    this.plans = {
      insert: (input) => {
        const result = run(w.insertPlan, input.title, input.description, input.now, input.now);
        return mustGet(getPlan(formatId('plan', Number(result.lastInsertRowid))), 'plan');
      },
      get: getPlan,
      list: (filter) =>
        all(q.listPlansByStatus, filter.status ?? 'active').map((row) => rowToPlan(row)),
      update: (id, patch, now) => {
        const current = mustGet(getPlan(id), `plan ${id}`);
        run(
          w.updatePlan,
          patch.title ?? current.title,
          patch.description ?? current.description,
          patch.status ?? current.status,
          now,
          parseId('plan', id),
        );
        return mustGet(getPlan(id), `plan ${id}`);
      },
      countByStatus: () => countsFrom(all(q.countPlansByStatus), PLAN_STATUSES),
    };

    const getWorkItem = (id: WorkItemId): WorkItem | null => {
      const row = one(q.getWorkItem, parseId('workItem', id));
      return row === undefined ? null : rowToWorkItem(row);
    };
    this.workItems = {
      insert: (input) => {
        const result = run(
          w.insertWorkItem,
          parseId('plan', input.planId),
          input.splitFromId === null ? null : parseId('workItem', input.splitFromId),
          input.title,
          input.description,
          input.branch,
          input.now,
          input.now,
        );
        return mustGet(getWorkItem(formatId('workItem', Number(result.lastInsertRowid))), 'item');
      },
      get: getWorkItem,
      list: (filter) => {
        const statuses = filter.statuses === undefined ? null : JSON.stringify(filter.statuses);
        let rows: Row[];
        if (filter.planId !== undefined) {
          const planRowId = parseId('plan', filter.planId);
          rows =
            statuses === null
              ? all(q.listWorkItemsForPlan, planRowId)
              : all(q.listWorkItemsForPlanByStatus, planRowId, statuses);
        } else {
          rows = all(q.listWorkItemsByStatus, statuses ?? JSON.stringify(WORK_ITEM_STATUSES));
        }
        return rows.map((row) => rowToWorkItem(row));
      },
      update: (id, patch: WorkItemPatch, now) => {
        const current = mustGet(getWorkItem(id), `work item ${id}`);
        const workspace = patch.workspace === undefined ? current.workspace : patch.workspace;
        try {
          run(
            w.updateWorkItem,
            patch.title ?? current.title,
            patch.description ?? current.description,
            patch.status ?? current.status,
            patch.branch === undefined ? current.branch : patch.branch,
            patch.prUrl === undefined ? current.prUrl : patch.prUrl,
            workspace?.repositoryCommonDir ?? null,
            workspace?.repositoryCommonDirFileId ?? null,
            workspace?.worktreeGitDir ?? null,
            workspace?.worktreeGitDirFileId ?? null,
            workspace?.worktreeRoot ?? null,
            now,
            parseId('workItem', id),
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new OrviaError(
              'WORKSPACE_CONFLICT',
              'another open work item is already bound to this worktree or branch',
              { workItemId: id, worktreeRoot: workspace?.worktreeRoot ?? null },
            );
          }
          throw error;
        }
        return mustGet(getWorkItem(id), `work item ${id}`);
      },
      countByStatus: () => countsFrom(all(q.countWorkItemsByStatus), WORK_ITEM_STATUSES),
    };

    const getRun = (id: RunId): AgentRun | null => {
      const row = one(q.getRun, parseId('run', id));
      return row === undefined ? null : rowToRun(row);
    };
    this.runs = {
      insert: (input) => {
        try {
          const result = run(
            w.insertRun,
            parseId('workItem', input.workItemId),
            input.cycleId === null ? null : parseId('cycle', input.cycleId),
            input.purpose,
            input.profileId,
            input.outputRef,
            input.now,
          );
          return mustGet(getRun(formatId('run', Number(result.lastInsertRowid))), 'run');
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new OrviaError(
              'RUN_IN_PROGRESS',
              `work item ${input.workItemId} already has a running agent`,
              { workItemId: input.workItemId },
            );
          }
          throw error;
        }
      },
      finish: (id, result) => {
        run(
          w.finishRun,
          result.status,
          result.exitCode,
          result.outputBytes,
          result.outputTruncated ? 1 : 0,
          result.now,
          parseId('run', id),
        );
        return mustGet(getRun(id), `run ${id}`);
      },
      get: getRun,
      current: (workItemId) => {
        const row = one(q.getCurrentRun, parseId('workItem', workItemId));
        return row === undefined ? null : rowToRun(row);
      },
      listForWorkItem: (workItemId) =>
        all(q.listRunsForWorkItem, parseId('workItem', workItemId)).map((row) => rowToRun(row)),
      listForCycle: (cycleId) =>
        all(q.listRunsForCycle, parseId('cycle', cycleId)).map((row) => rowToRun(row)),
      listRunning: () => all(q.listRunningRuns).map((row) => rowToRun(row)),
      setResult: (id, resultJson) => {
        run(w.setRunResult, resultJson, parseId('run', id));
      },
      markInterrupted: (id, now) => run(w.interruptRun, now, parseId('run', id)).changes === 1,
      listFinishedBeyond: (keep) =>
        all(q.finishedRunsBeyondKeep, keep).map((row) => ({
          runId: formatId('run', num(row, 'id')),
          outputRef: strOrNull(row, 'output_ref'),
        })),
      delete: (id) => {
        run(w.deleteRun, parseId('run', id));
      },
    };

    const getDecision = (id: DecisionId): Decision | null => {
      const row = one(q.getDecision, parseId('decision', id));
      return row === undefined ? null : rowToDecision(row);
    };
    this.decisions = {
      insert: (input) => {
        const result = run(
          w.insertDecision,
          parseId('plan', input.planId),
          input.workItemId === null ? null : parseId('workItem', input.workItemId),
          input.title,
          input.body,
          input.supersedesId === null ? null : parseId('decision', input.supersedesId),
          input.now,
        );
        return mustGet(
          getDecision(formatId('decision', Number(result.lastInsertRowid))),
          'decision',
        );
      },
      get: getDecision,
      markSuperseded: (id) => {
        run(w.supersedeDecision, parseId('decision', id));
      },
      listForPlan: (planId) =>
        all(q.listDecisionsForPlan, parseId('plan', planId)).map((row) => rowToDecision(row)),
    };

    this.notes = {
      insert: (input) => {
        const result = run(
          w.insertNote,
          parseId('plan', input.planId),
          input.workItemId === null ? null : parseId('workItem', input.workItemId),
          input.kind,
          input.body,
          input.now,
        );
        const row = one(q.getNote, Number(result.lastInsertRowid));
        if (row === undefined) throw new OrviaError('INTERNAL', 'inserted note not found');
        return rowToNote(row);
      },
      listForPlan: (planId) =>
        all(q.listNotesForPlan, parseId('plan', planId)).map((row) => rowToNote(row)),
    };

    const getCycle = (id: CycleId): Cycle | null => {
      const row = one(q.getCycle, parseId('cycle', id));
      return row === undefined ? null : rowToCycle(row);
    };
    this.cycles = {
      insert: (input) => {
        try {
          const result = run(
            w.insertCycle,
            parseId('workItem', input.workItemId),
            input.mode,
            input.state,
            input.maxAutoFixRounds,
            input.implementationProfileId,
            input.reviewProfileId,
            input.instructions,
            input.baseCommit,
            input.now,
            input.now,
          );
          return mustGet(getCycle(formatId('cycle', Number(result.lastInsertRowid))), 'cycle');
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new OrviaError(
              'CYCLE_ACTIVE',
              `work item ${input.workItemId} already has an active cycle`,
              { workItemId: input.workItemId },
            );
          }
          throw error;
        }
      },
      get: getCycle,
      active: (workItemId) => {
        const row = one(q.getActiveCycle, parseId('workItem', workItemId));
        return row === undefined ? null : rowToCycle(row);
      },
      listActive: () => all(q.listActiveCycles).map((row) => rowToCycle(row)),
      update: (id, patch, now) => {
        const current = mustGet(getCycle(id), `cycle ${id}`);
        const pick = <K extends keyof CyclePatch>(
          key: K,
          fallback: NonNullable<CyclePatch[K]> | null,
        ) => (patch[key] === undefined ? fallback : patch[key]);
        const currentRunId = pick('currentRunId', current.currentRunId);
        run(
          w.updateCycle,
          pick('state', current.state),
          pick('reason', current.reason),
          pick('resumeStage', current.resumeStage),
          pick('iteration', current.iteration),
          pick('autoFixRounds', current.autoFixRounds),
          currentRunId === null ? null : parseId('run', currentRunId),
          pick('completedAt', current.completedAt),
          now,
          parseId('cycle', id),
        );
        return mustGet(getCycle(id), `cycle ${id}`);
      },
    };

    const getReview = (id: ReviewId): Review | null => {
      const row = one(q.getReview, parseId('review', id));
      return row === undefined ? null : rowToReview(row);
    };
    this.reviews = {
      insert: (input) => {
        const result = run(
          w.insertReview,
          parseId('cycle', input.cycleId),
          input.runId === null ? null : parseId('run', input.runId),
          input.iteration,
          input.verdict,
          input.summary,
          input.now,
        );
        return mustGet(getReview(formatId('review', Number(result.lastInsertRowid))), 'review');
      },
      insertFinding: (input) => {
        const result = run(
          w.insertFinding,
          parseId('review', input.reviewId),
          input.category,
          input.title,
          input.detail,
          JSON.stringify(input.evidence),
          input.suggestedAction,
          input.policyAction,
          input.policyReason,
        );
        const row = one(q.getFinding, Number(result.lastInsertRowid));
        if (row === undefined) throw new OrviaError('INTERNAL', 'inserted finding not found');
        return rowToFinding(row);
      },
      get: getReview,
      latestForCycle: (cycleId) => {
        const row = one(q.getLatestReview, parseId('cycle', cycleId));
        return row === undefined ? null : rowToReview(row);
      },
      findings: (reviewId) =>
        all(q.listFindingsForReview, parseId('review', reviewId)).map((row) => rowToFinding(row)),
    };

    this.maintenance = {
      shape: () => this.#shape(),
      capacity: () => this.#capacity(this.#shape()),
      incrementalVacuum: () => {
        this.#applyCapacity('reserve');
        const before = num(one('PRAGMA freelist_count') ?? {}, 'freelist_count');
        try {
          this.#db.exec('PRAGMA incremental_vacuum');
        } catch (error) {
          throw this.#storageError(error, 'reserve');
        }
        const after = num(one('PRAGMA freelist_count') ?? {}, 'freelist_count');
        return { freedPages: before - after };
      },
      schemaStatus: (): SchemaStatus => ({
        databaseVersion: readHeader(this.#db).userVersion,
        supportedVersion: latestVersion(migrations),
        applied: readHistory(this.#db),
      }),
    };
  }

  /**
   * Every transaction is capped so that the main file plus its worst-case rollback journal plus
   * all other budgeted files stay within `storage.database_max_mb`; SQLite enforces the cap with
   * max_page_count and fails the transaction with SQLITE_FULL instead of growing past it.
   */
  transaction<T>(fn: () => SyncResult<T>, mode: TransactionMode = 'write'): T {
    if (this.#inTransaction()) {
      throw new OrviaError('INTERNAL', 'nested transactions are not supported');
    }
    this.#applyCapacity(mode);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#inTransaction()) this.#db.exec('ROLLBACK');
      throw this.#storageError(error, mode);
    }
  }

  #shape(): DatabaseShape {
    // The schema only changes through migrations, which finish before the store is created.
    this.#btreeCount ??= countSchemaBtrees(this.#db);
    return {
      pageSize: num(this.#prepare('PRAGMA page_size').get() ?? {}, 'page_size'),
      pageCount: num(this.#prepare('PRAGMA page_count').get() ?? {}, 'page_count'),
      btreeCount: this.#btreeCount,
    };
  }

  #capacity(shape: DatabaseShape): DatabaseCapacity {
    return databaseCapacity({
      budgetBytes: this.#budget.budgetBytes,
      fixedBytes: this.#budget.fixedBytes(),
      pageSize: shape.pageSize,
      btreeCount: shape.btreeCount,
    });
  }

  #applyCapacity(mode: TransactionMode): void {
    const shape = this.#shape();
    const capacity = this.#capacity(shape);
    if (shape.pageCount > capacity.maxPages) {
      // The journal of a transaction on a database this large could itself exceed the budget.
      throw this.#limitError(
        mode,
        shape,
        capacity,
        'the database is larger than the budget allows',
      );
    }
    const cap = mode === 'write' ? capacity.writeMaxPages : capacity.maxPages;
    // SQLite never lowers max_page_count below the current size, so writes on a database
    // already past writeMaxPages may still update in place but cannot grow it.
    this.#db.exec(`PRAGMA max_page_count = ${Math.max(cap, 1)}`);
  }

  #storageError(error: unknown, mode: TransactionMode): unknown {
    const translated = translateSqliteError(error);
    if (translated instanceof OrviaError && translated.code === 'STORAGE_HARD_LIMIT') {
      const shape = this.#shape();
      return this.#limitError(mode, shape, this.#capacity(shape), 'the change needs more space');
    }
    return translated;
  }

  #limitError(
    mode: TransactionMode,
    shape: DatabaseShape,
    capacity: DatabaseCapacity,
    reason: string,
  ): OrviaError {
    return new OrviaError(
      'STORAGE_HARD_LIMIT',
      `database storage limit: ${reason}; nothing was written. Run storage cleanup or raise ` +
        'storage.database_max_mb.',
      {
        blockedBy: ['database'],
        transactionMode: mode,
        configuredLimitBytes: this.#budget.budgetBytes,
        dataBytes: shape.pageCount * shape.pageSize,
        writeCapacityBytes: capacity.writeMaxPages * shape.pageSize,
        maxCapacityBytes: capacity.maxPages * shape.pageSize,
        otherFilesBytes: this.#budget.fixedBytes(),
      },
    );
  }

  #inTransaction(): boolean {
    return this.#db.isTransaction;
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }
}
