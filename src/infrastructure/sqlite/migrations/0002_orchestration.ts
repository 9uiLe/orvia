import type { Migration } from '../migrator.ts';

export const orchestration: Migration = {
  version: 2,
  name: 'orchestration',
  sql: `
CREATE TABLE cycles (
  id INTEGER PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_items (id),
  mode TEXT NOT NULL CHECK (mode IN ('implement', 'review_existing')),
  state TEXT NOT NULL CHECK (state IN ('IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING', 'NEEDS_HUMAN', 'PAUSED', 'BLOCKED', 'HUMAN_REVIEW_READY', 'FAILED', 'CANCELLED')),
  reason TEXT CHECK (reason IN ('DECISION_REQUIRED', 'REVIEWER_REQUESTED_HUMAN', 'AGENT_NEEDS_INPUT', 'FIX_DISPUTED', 'LOOP_LIMIT', 'REVIEW_PROTOCOL_INVALID', 'RESULT_PROTOCOL_INVALID', 'RUN_FAILED', 'RUN_INTERRUPTED', 'VERIFICATION_BLOCKED', 'START_FAILED', 'STORAGE_HARD_LIMIT', 'PAUSED_BY_HUMAN', 'CANCELLED_BY_HUMAN', 'INTERNAL_ERROR')),
  resume_stage TEXT CHECK (resume_stage IN ('IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'FIXING')),
  iteration INTEGER NOT NULL DEFAULT 0,
  auto_fix_rounds INTEGER NOT NULL DEFAULT 0,
  max_auto_fix_rounds INTEGER NOT NULL,
  implementation_agent TEXT NOT NULL,
  review_agent TEXT NOT NULL,
  instructions TEXT NOT NULL,
  current_run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;
CREATE INDEX cycles_by_work_item ON cycles (work_item_id, id);
CREATE INDEX cycles_by_state ON cycles (state);
CREATE UNIQUE INDEX cycles_one_active_per_work_item ON cycles (work_item_id)
  WHERE state NOT IN ('HUMAN_REVIEW_READY', 'FAILED', 'CANCELLED');

ALTER TABLE runs ADD COLUMN cycle_id INTEGER REFERENCES cycles (id);
ALTER TABLE runs ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manual'
  CHECK (purpose IN ('manual', 'implementation', 'verification', 'review', 'fix'));
ALTER TABLE runs ADD COLUMN result TEXT;
CREATE INDEX runs_by_cycle ON runs (cycle_id, id);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles (id),
  run_id INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  iteration INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'findings', 'needs_human')),
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX reviews_by_cycle ON reviews (cycle_id, id);

CREATE TABLE review_findings (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews (id),
  category TEXT NOT NULL CHECK (category IN ('correctness', 'test', 'build', 'style', 'decision_mismatch', 'acceptance_mismatch', 'design', 'scope', 'acceptance_criteria', 'public_api', 'database_schema', 'security', 'dependency', 'architecture', 'decision_conflict', 'ambiguous_requirement', 'unknown')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence TEXT NOT NULL,
  suggested_action TEXT,
  policy_action TEXT NOT NULL CHECK (policy_action IN ('AUTO_FIX', 'NEEDS_HUMAN')),
  policy_reason TEXT NOT NULL CHECK (policy_reason IN ('ROUTINE_FIX', 'HUMAN_CATEGORY', 'UNKNOWN_CATEGORY', 'INSUFFICIENT_EVIDENCE'))
) STRICT;
CREATE INDEX review_findings_by_review ON review_findings (review_id, id);
`,
};
