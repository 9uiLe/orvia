# Journal mode benchmark (2026-10-02)

Command: `npm run bench:storage` (defaults: 100 Plans × 5 Work Items seeded, then 500 iterations
of the mix below, each operation timed individually). A separate process sampled the size of
`state.db`, `-wal`, `-shm`, and `-journal` every millisecond.

- Machine: Apple M3 Max, macOS 27.0, APFS
- Runtime: Node.js 24.21.0 from the Nix shell (`flake.lock` of this commit), SQLite as linked by
  nixpkgs `nodejs_24`
- Operation mix: `create_plan`, `create_work_item`, `record_decision`, `add_context`,
  `submit_feedback`, `update_work_item`, `list_work_items`, `get_status`
- Three runs per configuration; ranges below are min–max across runs.

| Configuration                                             | write ops p50 | write ops p95 | `list_work_items` p95 | `get_status` p95 | mixed throughput  | peak WAL / journal      | peak total files      |
| --------------------------------------------------------- | ------------- | ------------- | --------------------- | ---------------- | ----------------- | ----------------------- | --------------------- |
| WAL (previous)                                            | 0.24–0.30 ms  | 0.35–0.41 ms  | 0.93–1.03 ms          | 1.24–1.30 ms     | 2,311–2,353 ops/s | WAL 4,124,152 B         | 4,816,896–4,845,048 B |
| Rollback journal, settings only (prototype)               | 0.39–0.51 ms  | 0.53–0.72 ms  | 0.98–1.03 ms          | 1.27–1.34 ms     | 1,686–1,908 ops/s | journal 25,136–33,344 B | 754,192–770,608 B     |
| Rollback journal + per-transaction capacity check (final) | 0.54–0.66 ms  | 0.65–0.85 ms  | 1.03–1.07 ms          | 1.39–1.43 ms     | 1,370–1,534 ops/s | journal 25,136–29,240 B | 758,296–758,320 B     |

Final file sizes after the run: WAL configuration `state.db` 720,896 B + `-wal` 4,096,000 B;
rollback configuration `state.db` 745,472 B and no journal.

Observations:

- Writes take roughly 0.2–0.45 ms longer at p95; reads are within about 0.15 ms. Every status
  query stays under 1.5 ms at p95, against the 50 ms budget candidate.
- WAL keeps a WAL file of one checkpoint interval (about 4 MB) next to a 0.7 MB database. With
  the rollback journal, the journal exists only during a transaction and is truncated to zero at
  commit.
- The CPU cost of the final configuration over the prototype is the per-transaction capacity
  computation (file sizes and page counts).
