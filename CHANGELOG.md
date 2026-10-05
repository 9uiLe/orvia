# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0.0, minor versions may contain breaking changes.

## [Unreleased]

### Fixed

- Checkpoint responses summarize code snapshots with HEAD, fingerprint and file count instead
  of exposing internal per-file identities. Large repositories no longer inflate prompt-inspection
  responses with those identities; stored code evidence and stale-prompt checks are preserved.
- Checkpoint prompts state Profile restrictions and store full requested deliverables in the
  manual work report's `content` field separately from its bounded summary. Older reports
  without `content` remain accepted.

### Added

- Confirmed immutable design revisions (`confirm_design`) and durable checkpoint prompts
  (`prepare_prompt`, `get_checkpoint`, `discard_prompt`). Preparation records the target,
  Profile and code state without launching a CLI.
- Structured manual work reports and app evaluations with human decisions
  (`record_checkpoint_review`). Reports, prompt text and review history survive normal Run
  pruning and cache cleanup; a finished checkpoint waits for human review.
- Current cumulative Git evidence (`get_checkpoint_changes`) with baseline commit, head,
  fingerprint, observation time and completeness, including staged and untracked contents.
  `get_checkpoint_source` reads byte pages with `nextOffset` and an expected fingerprint;
  binary and text pages currently use base64. External and Git administrative paths are refused.
- Database migration 0003: immutable `design_revisions` and durable `checkpoints`, including
  prepared context, report, review history and code fingerprints. Existing records are preserved
  without recognizing legacy runs as approved checkpoints.

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
- Agent Profiles (`agents.profiles` in `config.json`): a user-chosen id bound to an adapter,
  a command, and optionally fewer capabilities. Cycles and runs refer to profiles, not to agent
  CLIs. `list_agent_profiles` and `doctor` show each profile's availability, capabilities, and
  the stages it can run.
- Agent capabilities (`workspaceRead`, `workspaceWrite`, `commandExecution`,
  `structuredResult`). Each cycle stage requires a fixed set, checked before any agent starts
  (`AGENT_CAPABILITY_MISMATCH`), and each run is granted only its stage's set.
- `orchestration.default_implementation_profile` and `orchestration.default_review_profile`,
  used only when `start_cycle` names no profile.
- Reviews receive the change evidence (git status and the diff from the cycle's base commit)
  collected by Orvia. `start_cycle` accepts `baseRef`. Changes larger than
  `orchestration.max_review_diff_kb` (default 256) stop at `NEEDS_HUMAN / CHANGES_TOO_LARGE`.
- Database migration 0002: `cycles`, `reviews`, `review_findings`, and a purpose, cycle, and
  result for runs. Existing runs become manual runs, and `runs.agent` is renamed `profile_id`.
- `docs/dogfooding-log.md`: a template for notes from local use.

### Fixed

- Git evidence no longer hides executable mode changes when `core.filemode=false` or marks
  `assume-unchanged` / `skip-worktree` entries as complete. UTF-8 output obeys the requested
  byte budget, invalid text is marked partial, and untracked reads allocate by file size.
  Legacy review evidence includes untracked text and rejects incomplete evidence.
- Checkpoint/status views distinguish pending report persistence from failed persistence.
  Cleanup protects pending reports and their output even after the agent exits.
- Result schema write failures prevent agent launch; cache close errors are retained.
- Decisions cannot supersede a different Plan/Work Item target. Finished checkpoints can be
  reviewed while paused; continuing execution still requires explicit resume.
- Migration history with missing versions is rejected before mutation. Executable directories
  are no longer reported as available agent commands.
- Invalid CLI JSON input returns `VALIDATION_FAILED`. Malformed or interrupted IPC responses
  return `INTERNAL` instead of causing an uncaught exception or leaving a call pending.
- Benchmark workload counts reject invalid values before setup. The storage sampler is ready
  before measurement and is stopped and drained on both success and failure.

- The cache stays within `storage.cache_max_mb` while agents write: measuring the cache during a
  run no longer releases bytes that open writers have already taken.
- A stage's structured result has its cache space reserved before the agent starts, and Orvia
  failing to keep the output is reported as `RESULT_STORAGE_EXHAUSTED`, not as the agent's
  protocol error.
- Stopping the daemon during a run no longer logs a failed storage cleanup.
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
- A run whose agent fails to launch after the run is recorded is finished as `failed`; it no
  longer stays `running` and blocks the Work Item with `RUN_IN_PROGRESS` until a restart.
- A cancelled cycle no longer keeps the `resumeStage` of the paused, blocked, or escalated state
  it was cancelled from.
- `start_run` re-checks for an active cycle when it records the run, so a cycle started while
  the run was being prepared refuses it with `CYCLE_ACTIVE`.
- `doctor` takes the minimum Node.js version from `engines` in `package.json` and compares the
  patch version too.

### Changed

- `start_run` now accepts only `{ checkpointId }` and sends the saved prompt verbatim after
  freshness and workspace validation. The previous Work Item/Profile/free-text request is
  rejected; repeated dispatch of a checkpoint never launches another run.
- Standard continuation requires an app evaluation and human decision on the latest
  checkpoint; `continue` / `revise` permit a new preparation and `complete` completes the
  Work Item. Legacy cycles cannot start on a Work Item with a dispatched checkpoint.
- `get_run_output` exposes `availability` (`available`, `expired`, `unavailable`) and
  `truncated` separately. Full real-app checkpoint workflow verification remains outstanding.

- Automated cycles are legacy compatibility features, disabled by default.
  `start_cycle` and `resume_cycle` require `orchestration.enable_legacy_cycles=true` and return
  `LEGACY_CYCLES_DISABLED` otherwise. Existing history, reviews, pause, and cancel remain available;
  `list_agent_profiles` reports `legacyCyclesEnabled`.
- `start_run`, `complete_work_item`, and `archive_work_item` are refused with `CYCLE_ACTIVE`
  while the Work Item has an active cycle. `pause_work_item` also pauses that cycle.
- After a daemon restart, cycles that were running a stage are `BLOCKED / RUN_INTERRUPTED`;
  nothing is relaunched until a human resumes them.
- Agent selection uses Profiles: `prepare_prompt` takes `profileId`, and `start_cycle` takes
  `implementationProfileId` / `reviewProfileId`. Dispatch uses only `checkpointId`.
  The `agents.codex` and `agents.claude`
  configuration keys are replaced by `agents.profiles`; when it is not set, profiles named
  `codex` and `claude` use the bundled adapters.
- A stage that cannot start reports why (`AGENT_PROFILE_NOT_FOUND`,
  `AGENT_CAPABILITY_MISMATCH`, `AGENT_UNAVAILABLE`, `STORAGE_HARD_LIMIT`,
  `RESULT_STORAGE_EXHAUSTED`) instead of only `START_FAILED`.
- Verification lists only the checks it ran, not commands used to read files.
- Database writes are a few tenths of a millisecond slower (rollback journal; see
  `docs/benchmarks/2026-10-02-journal-mode.md`), and data can use about half of the database
  budget left after backups.
- `AgentAdapter` abstraction with experimental Codex and Claude Code adapters.
