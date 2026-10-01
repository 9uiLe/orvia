# 0002. SQLite: daemon-owned, single connection, short transactions, versioned migrations

- Status: Accepted
- Date: 2026-10-02

## Context

Durable state (Plans, Work Items, decisions, feedback) must survive restarts and upgrades. Agents
run for minutes; a write transaction must never span an agent run. Only the daemon may touch the
database. Sources: <https://sqlite.org/pragma.html>,
<https://sqlite.org/lang_transaction.html>, <https://nodejs.org/docs/latest-v24.x/api/sqlite.html>.

## Decision

### Ownership

- Only the daemon process opens `state.db`. The CLI and the MCP server call the daemon over a
  local socket ([0006](0006-local-mcp-boundary.md)).
- The connection sets `PRAGMA locking_mode = EXCLUSIVE`. SQLite then keeps its file lock for the
  life of the connection, so a second daemon, the `sqlite3` CLI, or an agent gets `SQLITE_BUSY`
  (tested across processes). The lock is an OS file lock, so a crashed daemon leaves nothing
  stale. Startup fails with `DATABASE_LOCKED` if another process owns the file.

### Concurrency

- One connection in one Node.js thread with a synchronous driver: there is exactly one writer by
  construction, and reads are served from the same connection. A pool of reader connections
  would only help with worker threads, and EXCLUSIVE locking rules it out; revisit if reads ever
  need parallelism.
- `Store.transaction()` accepts only a synchronous callback (enforced in the type), uses
  `BEGIN IMMEDIATE`, and commits before returning. An agent run is: commit the run record →
  start the agent → on exit, commit the result. A test performs writes while an agent runs.
- `busy_timeout` is 0. With a single owning connection there is nothing to wait for; a busy
  error means another process tried to open the file, which must fail fast.

### Configuration

| Setting              | Value                        | Reason                                                                                                                                           |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `journal_mode`       | `DELETE` (rollback journal)  | Its size is bounded by the database; WAL growth is not ([ADR 0009](0009-storage-contract.md)).                                                   |
| `journal_size_limit` | 0                            | In exclusive locking mode the journal is kept after commit; this truncates it to zero.                                                           |
| `cache_spill`        | OFF                          | The journal is synced once, at commit, so it has a single header.                                                                                |
| `temp_store`         | MEMORY                       | Sorts and transient indices create no files outside the budget.                                                                                  |
| `foreign_keys`       | on                           | `node:sqlite` enables it by default (`enableForeignKeyConstraints`).                                                                             |
| `auto_vacuum`        | `INCREMENTAL`                | Set before the first page is written (must precede `application_id`); lets cleanup return free pages with `incremental_vacuum`.                  |
| `max_page_count`     | set before every transaction | The page cap from the storage contract (ADR 0009). SQLite fails a transaction that would grow past it with `SQLITE_FULL` → `STORAGE_HARD_LIMIT`. |
| `application_id`     | `0x4f525649` ("ORVI")        | Foreign database files are rejected.                                                                                                             |

Storage cleanup runs `incremental_vacuum` after deleting rows, then re-measures. A database left in
WAL mode by an earlier build is converted at startup (ADR 0009).

### Query-driven schema

The schema was derived from the reads the application performs, listed by name in
`src/infrastructure/sqlite/queries.ts`:

| Query                                              | Index                                              |
| -------------------------------------------------- | -------------------------------------------------- |
| Get Plan / Work Item / Run / Decision / Note by id | rowid                                              |
| List active Plans                                  | `plans_by_status`                                  |
| List Work Items for a Plan (by status)             | `work_items_by_plan_status`                        |
| List open Work Items                               | `work_items_by_status`                             |
| Current run of a Work Item                         | `runs_one_running_per_work_item` (partial, unique) |
| Runs of a Work Item                                | `runs_by_work_item`                                |
| Running runs (status view)                         | `runs_one_running_per_work_item`                   |
| Decisions / notes of a Plan                        | `decisions_by_plan`, `notes_by_plan`               |
| Status counts                                      | covering scan of the status indexes                |

`test/integration/query-plans.test.ts` runs `EXPLAIN QUERY PLAN` on every named query and fails
on a full table scan. Partial unique indexes also enforce invariants: one open Work Item per
worktree and per branch, one running run per Work Item.

### Migrations

- Migrations are append-only TypeScript modules exporting SQL
  (`src/infrastructure/sqlite/migrations/NNNN_name.ts`), so they ship inside `dist/` with no
  copy step.
- The schema version is `PRAGMA user_version`. History (`version`, `name`, `checksum` (SHA-256
  of the SQL), `applied_at`) is in `orvia_schema_migrations`.
- At startup, before anything is written: `application_id` is checked, then a database newer
  than the binary fails closed with `UNSUPPORTED_DATABASE_VERSION` (tested: the file stays
  byte-identical), and a checksum mismatch fails with `MIGRATION_CHECKSUM_MISMATCH`.
- When migrations are pending, they never take Orvia's files past `storage.database_max_mb`:
  1. Leftover `*.partial` backups are deleted.
  2. **Storage preflight**, before anything is written, using the capacity model of
     [ADR 0009](0009-storage-contract.md) with the new backup (pages in use × `page_size`) added
     to the other files. The current page count plus any `headroomBytes` that pending migrations
     declare must fit within the write capacity, so the control reserve survives the migration.
     If it does not, startup fails with `MIGRATION_STORAGE_REQUIRED`. The details give
     the configured limit, current usage, the estimated required total, and the additional
     bytes needed. Nothing is changed.
  3. `integrity_check`, then a backup with `VACUUM INTO` (latest only; older backups are deleted
     after it succeeds; a partial file is removed on failure).
  4. `max_page_count` is set to the largest page count the budget allows. Each migration runs in
     its own `BEGIN IMMEDIATE` transaction with its history row and `user_version`. A
     migration that grows past the cap gets `SQLITE_FULL`, is rolled back, and fails with
     `MIGRATION_STORAGE_REQUIRED`. Any other failure rolls back with `MIGRATION_FAILED`. The
     backup is kept for recovery in both cases.
  5. `integrity_check`.
- This means migrating needs roughly three times the database size within the budget (database,
  journal, backup). If the database has grown past about a third of `database_max_mb`, raise the
  limit before upgrading. Because the daemon cannot start until migrations succeed, `orvia
cleanup` is not available at that point. Old backups can be deleted from the backup directory
  by hand.
- Per the SQLite documentation, `VACUUM INTO` writes the vacuumed copy directly into the target
  file instead of the transient database a plain `VACUUM` uses. Other temporary data stays in
  memory with `temp_store = MEMORY` (ADR 0009 describes the test and the limits of that claim).
- Backups and the rollback journal count toward the database budget. Backups expire after
  `retention_days`.
- Large changes follow expand → migrate/backfill → contract across releases. A migration that
  must rebuild a table follows SQLite's documented 12-step procedure.

## Consequences

- No external tool can read the database while the daemon runs. Debugging goes through
  `orvia` commands, or stop the daemon first.
- Throughput is bounded by one thread. The benchmark (`npm run bench`) shows sub-millisecond
  status queries on a developer laptop, so this is not a constraint today.
