import type { Migration } from '../migrator.ts';

// Indexes are derived from the queries in ../queries.ts; test/integration/query-plans.test.ts
// fails if one of those queries stops using an index.
export const initial: Migration = {
  version: 1,
  name: 'initial',
  sql: `
CREATE TABLE plans (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX plans_by_status ON plans (status);

CREATE TABLE work_items (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans (id),
  split_from_id INTEGER REFERENCES work_items (id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  branch TEXT,
  repository_common_dir TEXT,
  repository_common_dir_file_id TEXT,
  worktree_git_dir TEXT,
  worktree_git_dir_file_id TEXT,
  worktree_root TEXT,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (repository_common_dir IS NULL AND repository_common_dir_file_id IS NULL
      AND worktree_git_dir IS NULL AND worktree_git_dir_file_id IS NULL
      AND worktree_root IS NULL)
    OR
    (repository_common_dir IS NOT NULL AND repository_common_dir_file_id IS NOT NULL
      AND worktree_git_dir IS NOT NULL AND worktree_git_dir_file_id IS NOT NULL
      AND worktree_root IS NOT NULL AND branch IS NOT NULL)
  )
) STRICT;
CREATE INDEX work_items_by_plan_status ON work_items (plan_id, status);
CREATE INDEX work_items_by_status ON work_items (status);
CREATE UNIQUE INDEX work_items_one_open_per_worktree ON work_items (worktree_root)
  WHERE worktree_root IS NOT NULL AND status IN ('active', 'paused');
CREATE UNIQUE INDEX work_items_one_open_per_branch ON work_items (repository_common_dir, branch)
  WHERE repository_common_dir IS NOT NULL AND status IN ('active', 'paused');

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_items (id),
  agent TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  exit_code INTEGER,
  output_ref TEXT,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX runs_by_work_item ON runs (work_item_id, id);
CREATE UNIQUE INDEX runs_one_running_per_work_item ON runs (work_item_id)
  WHERE status = 'running';

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans (id),
  work_item_id INTEGER REFERENCES work_items (id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'superseded')),
  supersedes_id INTEGER REFERENCES decisions (id),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX decisions_by_plan ON decisions (plan_id);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans (id),
  work_item_id INTEGER REFERENCES work_items (id),
  kind TEXT NOT NULL CHECK (kind IN ('context', 'comment', 'redirect', 'reject')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX notes_by_plan ON notes (plan_id);
`,
};
