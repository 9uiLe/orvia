import { ACTIVE_STATES } from '../../domain/cycle.ts';

const PLAN_COLUMNS = 'id, title, description, status, created_at, updated_at';
const WORK_ITEM_COLUMNS = `id, plan_id, split_from_id, title, description, status, branch,
  repository_common_dir, repository_common_dir_file_id, worktree_git_dir,
  worktree_git_dir_file_id, worktree_root, pr_url, created_at, updated_at`;
const RUN_COLUMNS = `id, work_item_id, cycle_id, purpose, profile_id, status, exit_code, output_ref,
  output_bytes, output_truncated, result, started_at, finished_at`;
const CYCLE_COLUMNS = `id, work_item_id, mode, state, reason, resume_stage, iteration,
  auto_fix_rounds, max_auto_fix_rounds, implementation_profile, review_profile, instructions,
  base_commit, current_run_id, started_at, updated_at, completed_at`;
const ACTIVE_CYCLE_STATES = ACTIVE_STATES.map((state) => `'${state}'`).join(', ');
const REVIEW_COLUMNS = 'id, cycle_id, run_id, iteration, verdict, summary, created_at';
const FINDING_COLUMNS = `id, review_id, category, title, detail, evidence, suggested_action,
  policy_action, policy_reason`;
const DECISION_COLUMNS =
  'id, plan_id, work_item_id, title, body, status, supersedes_id, created_at';
const NOTE_COLUMNS = 'id, plan_id, work_item_id, kind, body, created_at';

/**
 * Every read the application performs, by name. The schema's indexes are derived from these;
 * test/integration/query-plans.test.ts checks them with EXPLAIN QUERY PLAN.
 */
export const READ_QUERIES = {
  getCycle: `SELECT ${CYCLE_COLUMNS} FROM cycles WHERE id = ?`,
  getActiveCycle: `SELECT ${CYCLE_COLUMNS} FROM cycles
    WHERE work_item_id = ? AND state IN (${ACTIVE_CYCLE_STATES})`,
  listActiveCycles: `SELECT ${CYCLE_COLUMNS} FROM cycles
    WHERE state IN (${ACTIVE_CYCLE_STATES}) ORDER BY id`,
  getReview: `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE id = ?`,
  getLatestReview: `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE cycle_id = ?
    ORDER BY id DESC LIMIT 1`,
  getFinding: `SELECT ${FINDING_COLUMNS} FROM review_findings WHERE id = ?`,
  listFindingsForReview: `SELECT ${FINDING_COLUMNS} FROM review_findings WHERE review_id = ?
    ORDER BY id`,

  getPlan: `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`,
  listPlansByStatus: `SELECT ${PLAN_COLUMNS} FROM plans WHERE status = ? ORDER BY id`,
  countPlansByStatus: 'SELECT status, count(*) AS n FROM plans GROUP BY status',

  getWorkItem: `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE id = ?`,
  listWorkItemsForPlan: `SELECT ${WORK_ITEM_COLUMNS} FROM work_items WHERE plan_id = ? ORDER BY id`,
  listWorkItemsForPlanByStatus: `SELECT ${WORK_ITEM_COLUMNS} FROM work_items
    WHERE plan_id = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY id`,
  listWorkItemsByStatus: `SELECT ${WORK_ITEM_COLUMNS} FROM work_items
    WHERE status IN (SELECT value FROM json_each(?)) ORDER BY id`,
  countWorkItemsByStatus: 'SELECT status, count(*) AS n FROM work_items GROUP BY status',

  getRun: `SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`,
  getCurrentRun: `SELECT ${RUN_COLUMNS} FROM runs WHERE work_item_id = ? AND status = 'running'`,
  listRunsForWorkItem: `SELECT ${RUN_COLUMNS} FROM runs WHERE work_item_id = ? ORDER BY id DESC`,
  listRunsForCycle: `SELECT ${RUN_COLUMNS} FROM runs WHERE cycle_id = ? ORDER BY id DESC`,
  listRunningRuns: `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' ORDER BY id`,
  finishedRunsBeyondKeep: `SELECT id, output_ref FROM (
      SELECT id, output_ref,
        row_number() OVER (PARTITION BY work_item_id ORDER BY id DESC) AS position
      FROM runs WHERE status <> 'running'
    ) WHERE position > ?`,

  getDecision: `SELECT ${DECISION_COLUMNS} FROM decisions WHERE id = ?`,
  listDecisionsForPlan: `SELECT ${DECISION_COLUMNS} FROM decisions WHERE plan_id = ? ORDER BY id`,
  getNote: `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`,
  listNotesForPlan: `SELECT ${NOTE_COLUMNS} FROM notes WHERE plan_id = ? ORDER BY id`,
} as const;

export type ReadQueryName = keyof typeof READ_QUERIES;

export const WRITE_STATEMENTS = {
  insertPlan: `INSERT INTO plans (title, description, status, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?)`,
  updatePlan: `UPDATE plans SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`,

  insertWorkItem: `INSERT INTO work_items
    (plan_id, split_from_id, title, description, status, branch, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
  updateWorkItem: `UPDATE work_items SET title = ?, description = ?, status = ?, branch = ?,
    pr_url = ?, repository_common_dir = ?, repository_common_dir_file_id = ?,
    worktree_git_dir = ?, worktree_git_dir_file_id = ?, worktree_root = ?, updated_at = ?
    WHERE id = ?`,

  insertRun: `INSERT INTO runs (work_item_id, cycle_id, purpose, profile_id, status, output_ref,
    started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  setRunResult: 'UPDATE runs SET result = ? WHERE id = ?',
  insertCycle: `INSERT INTO cycles (work_item_id, mode, state, max_auto_fix_rounds,
    implementation_profile, review_profile, instructions, base_commit, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateCycle: `UPDATE cycles SET state = ?, reason = ?, resume_stage = ?, iteration = ?,
    auto_fix_rounds = ?, current_run_id = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
  insertReview: `INSERT INTO reviews (cycle_id, run_id, iteration, verdict, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  insertFinding: `INSERT INTO review_findings (review_id, category, title, detail, evidence,
    suggested_action, policy_action, policy_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  finishRun: `UPDATE runs SET status = ?, exit_code = ?, output_bytes = ?, output_truncated = ?,
    finished_at = ? WHERE id = ? AND status = 'running'`,
  interruptRun: `UPDATE runs SET status = 'interrupted', finished_at = ?
    WHERE id = ? AND status = 'running'`,
  deleteRun: 'DELETE FROM runs WHERE id = ?',

  insertDecision: `INSERT INTO decisions
    (plan_id, work_item_id, title, body, status, supersedes_id, created_at)
    VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
  supersedeDecision: `UPDATE decisions SET status = 'superseded' WHERE id = ?`,
  insertNote: `INSERT INTO notes (plan_id, work_item_id, kind, body, created_at)
    VALUES (?, ?, ?, ?, ?)`,
} as const;
