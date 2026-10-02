# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, minor versions may contain breaking changes.

## [Unreleased]

### Added

- Nix flake development environment (Node.js 24, git, sqlite) pinned by `flake.lock`.
- Plans, Work Items (with split lineage), decisions with supersession, human context and
  feedback.
- Git worktree discovery, Work Item ↔ worktree binding, and workspace identity validation that
  fails closed with `WORKSPACE_MISMATCH`.
- Daemon-owned SQLite database with versioned, checksummed migrations, backups, and refusal of
  newer schemas.
- Configurable storage limits with pressure levels, automatic cleanup, and `HARD_LIMIT` gating.
- `orvia` CLI, local IPC socket, and an MCP server over stdio.
- JSON configuration (`config.json`) validated at startup.
- Experimental orchestration cycles (`start_cycle`, `get_cycle`, `pause_cycle`, `resume_cycle`,
  `cancel_cycle`): implement → verify → review, automatic fixes for routine findings and failed
  checks, and escalation to `NEEDS_HUMAN` when a human decision is needed. A cycle ends at
  `HUMAN_REVIEW_READY`; Orvia does not create or merge PRs. At most one active cycle per Work
  Item.
- Durable reviews and size-limited structured findings (`get_current_review`, `get_review`),
  each classified by a fixed policy as an automatic fix or a question for the human.
- Structured stage results: Codex `--output-schema` and Claude Code `--json-schema`, validated
  by Orvia and rejected (never truncated or interpreted) when invalid.
- `orchestration.max_review_fix_cycles` (default 3): automatic fix rounds before a cycle stops
  at `NEEDS_HUMAN / LOOP_LIMIT`; the count restarts when a human resumes.
- `get_status` shows each open Work Item's active cycle.
- Agent prompts state an instruction precedence and treat repository content other than
  AGENTS.md / CLAUDE.md as data.
- Database migration 0002: `cycles`, `reviews`, `review_findings`, and a purpose, cycle, and
  result for runs. Existing runs become manual runs.

### Fixed

- Migrations no longer exceed `storage.database_max_mb`: a preflight refuses them with
  `MIGRATION_STORAGE_REQUIRED` when the database, rollback journal, and backup would not fit, and
  a migration that outgrows the budget is rolled back.
- `pause_work_item` now stops the agent's whole process group (macOS/Linux), escalating from
  `SIGTERM` to `SIGKILL`, and returns only after it is gone; it fails with
  `AGENT_TERMINATION_FAILED` instead of reporting a paused Work Item whose agent still runs.
  Daemon shutdown uses the same procedure.
- `storage.database_max_mb` is now a hard budget during normal operation, not only during
  migrations. The database uses a rollback journal instead of WAL. Every transaction is capped
  so that the database, its worst-case journal, and backups fit. Writes that would not fit fail
  with `STORAGE_HARD_LIMIT` and are rolled back. A database left in WAL mode is converted at
  startup only if the conversion peak fits. SQLite temporary data is kept in memory.
- Control and maintenance transactions that may use the storage reserve change one row each:
  startup recovery and run pruning now commit one run per transaction, so runs already handled
  stay handled if they stop partway. If startup recovery runs out of reserve, the daemon starts
  in a degraded state: reads, storage status, and cleanup work, and writes and `start_run` are
  refused with `RECOVERY_INCOMPLETE` until cleanup or a larger budget and a restart. After each
  migration, the reserve is re-checked against the actual schema before COMMIT, and a migration
  that leaves no reserve is rolled back with `MIGRATION_STORAGE_REQUIRED`.

### Changed

- `start_run`, `complete_work_item`, and `archive_work_item` are refused with `CYCLE_ACTIVE`
  while the Work Item has an active cycle. `pause_work_item` also pauses that cycle.
- After a daemon restart, cycles that were running a stage are `BLOCKED / RUN_INTERRUPTED`;
  nothing is relaunched until a human resumes them.
- Database writes are a few tenths of a millisecond slower (rollback journal; see
  `docs/benchmarks/2026-10-02-journal-mode.md`), and data can use about half of the database
  budget left after backups.
- `AgentAdapter` abstraction with experimental Codex and Claude Code adapters.
