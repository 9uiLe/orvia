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

```toml
[storage]
database_max_mb = 128              # state.db + WAL + SHM + migration backups
cache_max_mb = 512                 # everything under the cache directory
retention_days = 7                 # cache entries and migration backups
max_completed_runs_per_work_item = 5
pressure_percent = 70              # start cleanup
warning_percent = 90               # report WARNING
```

Provenance: the four size and count defaults are the values proposed in the project brief; the
two thresholds were chosen by the maintainer. None of them is derived from measurements yet.
For scale, the benchmark data set (100 Plans, 500 Work Items, 100 decisions, 100 notes)
measured 151,552 bytes after cleanup on 2026-10-02. Revisit the defaults when real usage data exists.

Validation rejects unknown keys, non-integers, non-positive values, thresholds outside 1–99,
`pressure_percent >= warning_percent`, and a database limit that does not exceed the maintenance
reserve.

### Pressure levels

For each area (database, cache):

| Level        | Condition                         | Effect                          |
| ------------ | --------------------------------- | ------------------------------- |
| `NORMAL`     | below `pressure_percent`          | —                               |
| `PRESSURE`   | ≥ `pressure_percent` of the limit | cleanup starts automatically    |
| `WARNING`    | ≥ `warning_percent`               | reported in status              |
| `HARD_LIMIT` | ≥ limit − reserve                 | new writes / agent runs refused |

The database **maintenance reserve** is one WAL checkpoint interval
(`wal_autocheckpoint × page_size`, 4,096,000 bytes with SQLite defaults): the WAL can grow by up
to that much before a checkpoint, and cleanup needs to be able to write it. The cache needs no
reserve because relieving it only deletes files.

At `HARD_LIMIT`:

| Operation class                                            | Database at HARD_LIMIT | Cache at HARD_LIMIT |
| ---------------------------------------------------------- | ---------------------- | ------------------- |
| read (status, storage status, lists)                       | allowed                | allowed             |
| control (pause, resume)                                    | allowed                | allowed             |
| maintenance (cleanup, archive)                             | allowed                | allowed             |
| write (create, update, context, decisions, feedback, bind) | refused                | allowed             |
| agent_run (`start_run`)                                    | refused                | refused             |

Beyond the gate, SQLite's `max_page_count` stops the main database file at `database_max_mb`,
and the cache writer stops writing (marking output `truncated`) when the shared cache budget is
used up.

### Cleanup

Triggers: daemon start, after any write or agent run when storage is above `NORMAL`, and
`run_storage_cleanup`. Steps, each failure recorded and the next step still run:

1. Delete run records beyond the per-Work-Item count and their cache files.
2. Delete expired cache entries, then the oldest entries until the cache is below
   `pressure_percent` (output of running agents is never deleted).
3. Delete migration backups older than `retention_days`.
4. `wal_checkpoint(TRUNCATE)` and `incremental_vacuum`.
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

- Durable data alone can reach `HARD_LIMIT`; then the user must archive data (a future export
  or delete feature) or raise `database_max_mb`.
- Orvia's own logs go to stderr; persisting and rotating them belongs to the process supervisor
  (launchd, systemd, a terminal).
