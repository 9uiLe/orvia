# 0004. Bounded storage

- Status: Accepted
- Date: 2026-10-02

## Context

Agents produce a lot of output. A local tool that grows without bound eventually fills the
user's disk. Orvia must never risk the user's source code to free its own space.

## Decision

### Classification

| Class            | Examples                                                                                   | Where           | Lifetime                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------- |
| Durable          | Plans, Work Items (incl. workspace binding, PR URL), decisions, human context and feedback | SQLite          | Never removed automatically                                                                              |
| Bounded metadata | Agent Run records (status, exit code, output reference)                                    | SQLite          | The newest `max_completed_runs_per_work_item` finished runs per Work Item; running runs are never pruned |
| Reconstructible  | git diffs, source scans, repository snapshots, build details                               | Not stored      | Recomputed from git when needed                                                                          |
| Ephemeral        | Agent stdout/stderr                                                                        | Cache directory | `retention_days`, and evicted oldest-first under pressure                                                |

Prompts are passed to agents on stdin and never written to disk. Large text (agent output,
diffs, source) is never stored in SQLite; run records keep only a cache reference and byte
counts.

### Limits and defaults

```json
{
  "storage": {
    "database_max_mb": 128,
    "cache_max_mb": 512,
    "retention_days": 7,
    "max_completed_runs_per_work_item": 5,
    "pressure_percent": 70,
    "warning_percent": 90
  }
}
```

`database_max_mb` is a hard budget for state.db, its rollback journal, any leftover WAL or SHM,
and the backup directory; its exact meaning and enforcement are in
[ADR 0009](0009-storage-contract.md). `cache_max_mb` covers
everything under the cache directory. `retention_days` applies to cache entries and migration
backups. Cleanup starts at `pressure_percent`, and status reports `WARNING` at `warning_percent`.

Provenance: the four size and count defaults are the values proposed in the project brief; the
two thresholds were chosen by the maintainer. None of them is derived from measurements yet.
For scale, the benchmark data set (100 Plans, 500 Work Items, 100 decisions, 100 notes)
measured 151,552 bytes after cleanup on 2026-10-02. Revisit the defaults when real usage data exists.

Validation rejects unknown keys, non-integers, non-positive values, thresholds outside 1–99,
`pressure_percent >= warning_percent`, and a database limit that does not exceed the maintenance
reserve.

### Pressure levels

| Level        | Database: data (pages × page size) vs. write capacity | Cache: bytes vs. `cache_max_mb` | Effect                          |
| ------------ | ----------------------------------------------------- | ------------------------------- | ------------------------------- |
| `NORMAL`     | below `pressure_percent`                              | below `pressure_percent`        | —                               |
| `PRESSURE`   | ≥ `pressure_percent`                                  | ≥ `pressure_percent`            | cleanup starts automatically    |
| `WARNING`    | ≥ `warning_percent`                                   | ≥ `warning_percent`             | reported in status              |
| `HARD_LIMIT` | ≥ write capacity                                      | ≥ limit                         | new writes / agent runs refused |

The database **write capacity** is the data size at which ordinary writes stop. It leaves room
for each transaction's worst-case rollback journal and for a **control and maintenance reserve**:
the pages that pausing, recording a run's result, cleanup, or archiving can add, derived from
b-tree depth ([ADR 0009](0009-storage-contract.md)). The cache needs no reserve because relieving
it only deletes files.

Admission at `HARD_LIMIT` (the pre-operation gate):

| Operation class                                             | Database at HARD_LIMIT | Cache at HARD_LIMIT |
| ----------------------------------------------------------- | ---------------------- | ------------------- |
| read (status, storage status, lists)                        | allowed                | allowed             |
| control (pause, resume)                                     | allowed                | allowed             |
| maintenance (cleanup; archive, which frees almost no space) | allowed                | allowed             |
| write (create, update, context, decisions, feedback, bind)  | refused                | allowed             |
| agent_run (`start_run`)                                     | refused                | refused             |

Allowed classes are not refused by the gate, but their transactions can still fail once the
shared reserve is used up ([ADR 0009](0009-storage-contract.md)). If that happens during startup
recovery, the daemon starts degraded instead of failing.

The pre-write check uses the last measurement. Every transaction is additionally capped by
SQLite's `max_page_count`, so a write that would not fit fails with `STORAGE_HARD_LIMIT` and is
rolled back instead of exceeding the budget, even below `HARD_LIMIT`. The cache writer stops
writing (marking output `truncated`) when the shared cache budget is used up.

### Cleanup

Triggers: daemon start, after any write or agent run when storage is above `NORMAL`, and
`run_storage_cleanup`. Steps, each failure recorded and the next step still run:

1. Delete run records beyond the per-Work-Item count and their cache files.
2. Delete expired cache entries, then the oldest entries until the cache is below
   `pressure_percent` (output of running agents is never deleted).
3. Delete migration backups older than `retention_days`.
4. `incremental_vacuum`, which returns the freed pages to the filesystem.
5. Re-measure.

Expiry is enforced when cleanup runs, not by a timer. The cache only grows through agent runs,
and every run is followed by a cleanup check.

### Separation from git

Storage cleanup only touches database rows, the cache directory (paths are checked to stay
inside it), and the backup directory. It has no access to git; Orvia has no code that mutates
git at all. A test snapshots a repository and worktree (HEAD, refs, worktrees, index, status,
object counts, untracked and modified files) around repeated cleanups. Git cleanup (removing
branches or worktrees), if ever added, will be a separate, explicit feature.

## Consequences

- **Durable data alone can reach `HARD_LIMIT`, and today the only remedy is raising
  `database_max_mb`.** Cleanup never deletes durable data. Archiving a Plan or Work Item only
  changes its status and frees almost no space; it is allowed at `HARD_LIMIT` so that work can be
  wound down, not to reclaim storage. A future milestone adds explicit recovery paths:
  export (durable data to a file the user owns), explicit delete of archived Plans and Work
  Items, and database compaction (`VACUUM`) as a maintenance command.
- Migrations need room for the database, a rollback journal, and a backup at the same time
  ([ADR 0002](0002-sqlite.md)). If that does not fit, the daemon refuses to start with
  `MIGRATION_STORAGE_REQUIRED` instead of exceeding the limit.
- Orvia's own logs go to stderr; persisting and rotating them belongs to the process supervisor
  (launchd, systemd, a terminal).
