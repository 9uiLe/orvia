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
  startup recovery and run pruning now commit one run per transaction (restartable). After each
  migration, the reserve is re-checked against the actual schema before COMMIT, and a migration
  that leaves no reserve is rolled back with `MIGRATION_STORAGE_REQUIRED`.

### Changed

- Database writes are a few tenths of a millisecond slower (rollback journal; see
  `docs/benchmarks/2026-10-02-journal-mode.md`), and data can use about half of the database
  budget left after backups.
- `AgentAdapter` abstraction with experimental Codex and Claude Code adapters.
