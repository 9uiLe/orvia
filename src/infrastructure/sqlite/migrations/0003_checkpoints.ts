import type { Migration } from '../migrator.ts';

export const checkpoints: Migration = {
  version: 3,
  name: 'checkpoints',
  sql: `
CREATE TABLE design_revisions (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans (id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  goal TEXT NOT NULL,
  scope TEXT NOT NULL,
  constraints_text TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX design_revisions_by_plan ON design_revisions (plan_id, revision);

CREATE TABLE checkpoints (
  id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_items (id),
  design_revision_id INTEGER NOT NULL REFERENCES design_revisions (id),
  profile_id TEXT NOT NULL,
  instructions TEXT NOT NULL,
  end_condition TEXT NOT NULL,
  prompt TEXT NOT NULL,
  prepared_context TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  previous_checkpoint_id INTEGER REFERENCES checkpoints (id),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'running', 'awaiting_review', 'reviewed', 'discarded')),
  run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  run_status TEXT CHECK (run_status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
  report TEXT,
  report_error TEXT,
  end_code TEXT,
  reviews TEXT NOT NULL DEFAULT '[]',
  prepared_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;
CREATE INDEX checkpoints_by_work_item ON checkpoints (work_item_id, id);
CREATE UNIQUE INDEX checkpoints_by_run ON checkpoints (run_id);
CREATE INDEX checkpoints_running ON checkpoints (id) WHERE state = 'running';
`,
};
