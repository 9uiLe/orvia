# 0009. Storage contract: `database_max_mb` is a hard budget, enforced with a rollback journal

- Status: Accepted. Supersedes the WAL configuration in [ADR 0002](0002-sqlite.md) and the WAL-based
  maintenance reserve in [ADR 0004](0004-storage-policy.md).
- Date: 2026-10-02

## Context

`storage.database_max_mb` was documented as the limit for all database-related files. In WAL mode,
however, `max_page_count` only limits the main file, and a transaction's WAL growth cannot be
capped. A write starting at 120 MiB of a 128 MiB budget could reach 140 MiB and be cleaned up
afterwards. That is a cleanup threshold, not a limit.

## SQLite facts this relies on (sqlite.org, read 2026-10-02)

- Rollback journal (fileformat2.html): "Each page record stores a copy of the content of a page
  from the database file before it was changed. The same page may not appear more than once
  within a single rollback journal." A record is a 4-byte page number, the page, and a 4-byte
  checksum. The header records the original database size; pages appended beyond it have no prior
  content to save.
- Exclusive locking (tempfiles.html §2.1): the journal "is not deleted" after commit in exclusive
  locking mode. journal_size_limit (pragma.html): "To always truncate rollback journals and WAL
  files to their minimum size, set the journal_size_limit to zero." This was verified: the
  journal is 0 bytes after every commit.
- WAL (wal.html §6): "the WAL file cannot be reset in the middle of a write transaction. So a large
  change to a large database might result in a large WAL file." No pragma caps it.
- max_page_count (limits.html): an insert "that would cause the database file to grow larger
  than this will return SQLITE_FULL". It cannot be lowered below the current size and does not
  apply to the journal or WAL.
- Errors in a transaction (lang_transaction.html §3): after SQLITE_FULL SQLite may undo only the
  statement or the whole transaction; the application should issue ROLLBACK. Orvia always does.
- Hot journals (lockingv3.html §4, atomiccommit.html §4.4): the next open rolls back the
  incomplete transaction and truncates the file to its original size.
- Temporary files (tempfiles.html): "The manner in which SQLite uses temporary files is not
  considered part of the contract." Journals and WAL are always on disk. TEMP databases,
  materializations, and transient indices (ORDER BY, GROUP BY, DISTINCT) follow `temp_store`. The
  documentation is ambiguous about statement journals.
- VACUUM INTO (lang_vacuum.html): writes into the INTO file "in place of the temporary database".

## Options

**A. Keep WAL and bound it.** This needs a per-transaction WAL estimate, `cache_size` large enough
that no page is written twice, and room for the WAL left after checkpoints (one checkpoint
interval, 4 MB by default, or 0 with `journal_size_limit = 0` plus a forced checkpoint after
every transaction). It also needs a separate bound for checkpoint peaks, where main growth and
WAL coexist. WAL's benefit, concurrent readers alongside a writer, does not apply: Orvia has one
connection in one thread.

**B. Rollback journal for every transaction.** The journal's worst case follows directly from
the documented format: the pages that existed when the transaction began, each at most once.
Migrations already used this model.

Measured on Orvia's operation mix
([benchmark](../benchmarks/2026-10-02-journal-mode.md)): option B is slower for writes, at
0.65–0.85 ms p95 instead of 0.35–0.41 ms. Status reads are 1.39–1.43 ms p95 instead of
1.24–1.30 ms. Peak file usage is 0.76 MB instead of 4.8 MB for 0.7 MB of data.

**Decision: B.** The latency cost is under 2% of the 50 ms budget candidate, storage peaks are
about six times smaller, and the bound is provable from the format instead of estimated.

## The contract

`storage.database_max_mb` bounds the sum of:

- `state.db`
- `state.db-journal` (rollback journal; 0 bytes between transactions)
- `state.db-wal` and `state.db-shm` (only from a database last written by an older build)
- everything in the backup directory (migration backups and partial backups)

Orvia's own database operations never make that sum exceed the budget. They are refused before
writing, or stopped by SQLite with SQLITE_FULL and rolled back.

Excluded, with reasons:

- **The OS temporary directory.** With `temp_store = MEMORY` the operations Orvia performs
  (sorting, grouping, DISTINCT, multi-row updates) were observed to create no temporary files. A
  test watches the directory and checks that the same workload with `temp_store = FILE` does
  create files. SQLite does not promise how it uses temporary files, so this is tested, not
  guaranteed.
- **Memory.** `temp_store = MEMORY` and `cache_spill = OFF` keep sort data and a transaction's
  dirty pages in memory. Both are bounded by the database size, which the budget bounds. The
  largest case is a migration that rewrites every page.
- **Filesystem overhead** (block rounding, directory entries) is outside SQLite's control.

## Mechanism

Connection settings (src/infrastructure/sqlite/database.ts):

- `journal_mode = DELETE`;
- `journal_size_limit = 0`, so the journal is truncated at commit;
- `cache_spill = OFF`, so the journal is synced once, at commit, and has a single header;
- `temp_store = MEMORY`.

Capacity (src/domain/storage.ts `databaseCapacity`):

```
perPage   = 2 × page_size + 8          main page + its journal record
maxPages  = ⌊(budget − otherFiles − 64 KiB journal header) / perPage⌋
writeMax  = maxPages − btrees × (⌈log2 maxPages⌉ + 1) − 1
```

`otherFiles` is the backups plus any leftover WAL, SHM, or journal, measured before every
transaction. 64 KiB is the largest sector, and therefore the largest journal header, that SQLite
writes. Before every transaction the store checks `page_count ≤ maxPages` and sets
`max_page_count` to `writeMax` for ordinary writes, or to `maxPages` for control and maintenance
(pause, recording a run's result, startup recovery, cleanup, archive, resume). The worst case of
any transaction is then `maxPages × page_size + maxPages × (page_size + 8) + header + otherFiles ≤
budget`. The reserve between `writeMax` and `maxPages` holds the pages that one row change per
b-tree can add: a split per level plus a new root, with depth at most log2(pages), and one
pointer-map page.

A consequence: data can use about half of what remains after backups. The other half is the
worst-case journal.

Pressure levels for the database measure data (page count × page size) against `writeMax`. When
a write is refused, the error gives the limit, usage, capacities, the operation class, and the
remedy (cleanup, or raise `storage.database_max_mb`).

## Startup, migration, and crash recovery

1. If a WAL file exists, the database was left in WAL mode. Converting it folds the WAL into the
   main file while both exist. Each WAL frame carries one page, so the main file grows by at
   most the WAL's size, and the peak is at most `all files + WAL`. This is checked **before
   SQLite opens the file**, because closing a WAL connection checkpoints it, which would itself
   change the files. If it does not fit, startup fails with `STORAGE_HARD_LIMIT` and the files
   are untouched.
2. Opening rolls back a hot journal left by a crash. That restores original pages and truncates
   to the original size, so recovery never grows storage. The leftover journal is counted and is
   truncated by the next commit.
3. Migrations use the same capacity model, with the new backup estimate (pages in use × page
   size) added to the other files. The result must fit within `writeMax`, so the reserve remains
   afterwards. Otherwise startup fails with `MIGRATION_STORAGE_REQUIRED` before anything is
   written. While migrating, `max_page_count` is `maxPages`.

## Consequences

- Writes are slower by a few tenths of a millisecond.
- Data capacity is about half the budget after backups. Storage status reports it as
  `writeCapacityBytes`.
- Durable data that reaches `writeMax` can only be relieved by raising the budget. Export and
  deletion are planned (ADR 0004).
- The temporary-file and memory behavior depends on SQLite internals that may change. The test
  in `test/integration/storage-contract.test.ts` would detect a change in SQLite's temporary file
  use for Orvia's workload.
