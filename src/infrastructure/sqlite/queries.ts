/**
 * Every read the application performs, by name. The schema's indexes are derived from these;
 * test/integration/query-plans.test.ts checks them with EXPLAIN QUERY PLAN.
 */
const PLAN_COLUMNS = 'id, title, description, status, created_at, updated_at';
const WORK_ITEM_COLUMNS = `id, plan_id, split_from_id, title, description, status, branch,
  repository_common_dir, repository_common_dir_file_id, worktree_git_dir,
  worktree_git_dir_file_id, worktree_root, pr_url, created_at, updated_at`;
const RUN_COLUMNS = `id, work_item_id, agent, status, exit_code, output_ref, output_bytes,
  output_truncated, started_at, finished_at`;
const DECISION_COLUMNS =
  'id, plan_id, work_item_id, title, body, status, supersedes_id, created_at';
const NOTE_COLUMNS = 'id, plan_id, work_item_id, kind, body, created_at';

export const READ_QUERIES = {
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
  listRunningRuns: `SELECT ${RUN_COLUMNS} FROM runs WHERE status = 'running' ORDER BY id`,

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

  insertRun: `INSERT INTO runs (work_item_id, agent, status, output_ref, started_at)
    VALUES (?, ?, 'running', ?, ?)`,
  finishRun: `UPDATE runs SET status = ?, exit_code = ?, output_bytes = ?, output_truncated = ?,
    finished_at = ? WHERE id = ? AND status = 'running'`,
  interruptRunningRuns: `UPDATE runs SET status = 'interrupted', finished_at = ?
    WHERE status = 'running' RETURNING id`,
  finishedRunsBeyondKeep: `SELECT id, output_ref FROM (
      SELECT id, output_ref,
        row_number() OVER (PARTITION BY work_item_id ORDER BY id DESC) AS position
      FROM runs WHERE status <> 'running'
    ) WHERE position > ?`,
  deleteRun: 'DELETE FROM runs WHERE id = ?',
  listOutputRefs: 'SELECT output_ref FROM runs WHERE output_ref IS NOT NULL',

  insertDecision: `INSERT INTO decisions
    (plan_id, work_item_id, title, body, status, supersedes_id, created_at)
    VALUES (?, ?, ?, ?, 'accepted', ?, ?)`,
  supersedeDecision: `UPDATE decisions SET status = 'superseded' WHERE id = ?`,
  insertNote: `INSERT INTO notes (plan_id, work_item_id, kind, body, created_at)
    VALUES (?, ?, ?, ?, ?)`,
} as const;
