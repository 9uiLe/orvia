import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { databaseUsedBytes, JOURNAL_HEADER_BYTES } from '../../src/domain/storage.ts';
import { measureDatabaseFiles } from '../../src/infrastructure/sqlite/database-files.ts';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import type { Migration } from '../../src/infrastructure/sqlite/migrator.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { config, makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { startStorageSampler, type StoragePeak } from '../helpers/storage-sampler.ts';

const KIB = 1024;
const MIB = 1024 * KIB;

describe('storage contract: database_max_mb is never exceeded', () => {
  let env: TestEnv;
  let daemon: Daemon | null;
  let samplers: { stop(): Promise<unknown> }[];

  beforeEach(() => {
    env = makeTestEnv();
    daemon = null;
    samplers = [];
    mkdirSync(env.paths.dataDir, { recursive: true });
  });
  afterEach(async () => {
    // A failed assertion must not leave a sampler process holding the test runner open.
    await Promise.all(samplers.map((sampler) => sampler.stop()));
    await daemon?.close();
    env.cleanup();
  });

  async function start(databaseMaxMb: number, migrations?: readonly Migration[]) {
    daemon = await startTestDaemon(env, {
      config: config({ storage: { database_max_mb: databaseMaxMb } }),
      ...(migrations === undefined ? {} : { migrations }),
    });
    return daemon;
  }

  function used(): number {
    return databaseUsedBytes(measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir));
  }

  async function sampler() {
    const started = await startStorageSampler(env.paths.databaseFile, env.paths.backupDir);
    let result: Promise<StoragePeak> | null = null;
    const once = { stop: () => (result ??= started.stop()) };
    samplers.push(once);
    return once;
  }

  async function fillUntilRefused(d: Daemon, size: number): Promise<number> {
    let written = 0;
    for (let i = 0; i < 5000; i++) {
      try {
        await call(d.app, 'add_context', { planId: 'P-1', body: 'x'.repeat(size) });
        written++;
      } catch (error) {
        assert.equal((error as { code: string }).code, 'STORAGE_HARD_LIMIT');
        return written;
      }
    }
    throw new Error('writes were never refused');
  }

  function hash(path: string): string {
    return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '-';
  }

  test('durable writes near the limit are refused before the files exceed it', async () => {
    const d = await start(5);
    await call(d.app, 'create_plan', { title: 'P' });
    const peak = await sampler();
    const written = await fillUntilRefused(d, 64 * KIB);
    const observed = await peak.stop();
    assert.ok(written > 10, 'the budget was actually used');
    assert.ok(observed.total <= 5 * MIB, `peak ${observed.total}`);
    assert.ok(used() <= 5 * MIB);
  });

  test('a migration backup is part of the same budget', async () => {
    mkdirSync(env.paths.backupDir, { recursive: true });
    writeFileSync(join(env.paths.backupDir, 'state-v0-earlier.db'), Buffer.alloc(MIB + 512 * KIB));
    const d = await start(5);
    await call(d.app, 'create_plan', { title: 'P' });
    const peak = await sampler();
    await fillUntilRefused(d, 64 * KIB);
    const observed = await peak.stop();
    assert.ok(observed.total <= 5 * MIB, `peak ${observed.total}`);
    const status = await call<{ assessment: { database: { maxCapacityBytes: number } } }>(
      d.app,
      'get_storage_status',
    );
    assert.ok(status.assessment.database.maxCapacityBytes < (5 * MIB - 1.5 * MIB) / 2);
  });

  test('one oversized transaction is stopped by the page cap and writes nothing', async () => {
    const d = await start(5);
    await call(d.app, 'create_plan', { title: 'P' });
    const store = d.app.deps.store;
    const before = used();
    const peak = await sampler();
    assert.throws(
      () =>
        store.transaction(
          () =>
            store.notes.insert({
              planId: 'P-1',
              workItemId: null,
              kind: 'context',
              body: 'x'.repeat(6 * MIB),
              now: new Date().toISOString(),
            }),
          'reserve',
        ),
      (error: { code?: string; details?: Record<string, unknown> }) =>
        error.code === 'STORAGE_HARD_LIMIT' && error.details?.['configuredLimitBytes'] === 5 * MIB,
    );
    const observed = await peak.stop();
    assert.ok(observed.total <= 5 * MIB, `peak ${observed.total}`);
    const plan = await call<{ notes: unknown[] }>(d.app, 'get_plan', { planId: 'P-1' });
    assert.deepEqual(plan.notes, []);
    assert.ok(used() <= before, 'nothing was left behind');
    assert.equal(measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir).journalBytes, 0);
  });

  test("a transaction's journal stays within the bound the capacity model assumes", () => {
    const { db } = openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations: MIGRATIONS,
      now: () => new Date(),
      databaseMaxBytes: 128 * MIB,
    });
    try {
      db.exec(
        "INSERT INTO plans (title, description, status, created_at, updated_at) VALUES ('p', '', 'active', '', '')",
      );
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
               INSERT INTO notes (plan_id, kind, body, created_at)
               SELECT 1, 'context', hex(randomblob(1500)), '' FROM n`);
      const pageSize = Number(db.prepare('PRAGMA page_size').get()?.['page_size']);
      const pagesAtStart = Number(db.prepare('PRAGMA page_count').get()?.['page_count']);
      db.exec('BEGIN IMMEDIATE');
      db.exec("UPDATE notes SET body = body || ''");
      db.exec('DELETE FROM notes WHERE id % 2 = 0');
      const journal = statSync(`${env.paths.databaseFile}-journal`).size;
      db.exec('COMMIT');
      assert.ok(journal > pagesAtStart * pageSize * 0.5, 'the transaction touched most pages');
      assert.ok(journal <= pagesAtStart * (pageSize + 8) + JOURNAL_HEADER_BYTES);
      assert.equal(statSync(`${env.paths.databaseFile}-journal`).size, 0, 'truncated at commit');
    } finally {
      db.close();
    }
  });

  describe('a database left in WAL mode by a crash', () => {
    /** Builds an Orvia database, then writes to it in WAL mode and dies without checkpointing. */
    function crashInWalMode(rows: number): void {
      openDatabase({
        path: env.paths.databaseFile,
        backupDir: env.paths.backupDir,
        migrations: MIGRATIONS,
        now: () => new Date(),
        databaseMaxBytes: 128 * MIB,
      }).db.close();
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `const { DatabaseSync } = require('node:sqlite');
           const db = new DatabaseSync(process.argv[1]);
           db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
           const insert = db.prepare("INSERT INTO plans (title, description, status, created_at, updated_at) VALUES (hex(randomblob(1500)), '', 'active', '', '')");
           db.exec('BEGIN');
           for (let i = 0; i < Number(process.argv[2]); i++) insert.run();
           db.exec('COMMIT');
           process.kill(process.pid, 'SIGKILL');`,
          env.paths.databaseFile,
          String(rows),
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.signal, 'SIGKILL');
      assert.ok(existsSync(`${env.paths.databaseFile}-wal`), 'the WAL survived the crash');
    }

    test('startup refuses, unchanged, when leaving WAL would exceed the budget', () => {
      crashInWalMode(1500);
      const usage = measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir);
      const peak = databaseUsedBytes(usage) + usage.walBytes;
      const before = [hash(env.paths.databaseFile), hash(`${env.paths.databaseFile}-wal`)];
      assert.ok(
        databaseUsedBytes(usage) < peak - 1,
        'current files fit, the transition peak does not',
      );

      assert.throws(
        () =>
          openDatabase({
            path: env.paths.databaseFile,
            backupDir: env.paths.backupDir,
            migrations: MIGRATIONS,
            now: () => new Date(),
            databaseMaxBytes: peak - 1,
          }),
        { code: 'STORAGE_HARD_LIMIT' },
      );
      assert.deepEqual(
        [hash(env.paths.databaseFile), hash(`${env.paths.databaseFile}-wal`)],
        before,
        'nothing was changed',
      );
    });

    test('startup converts it within the budget and keeps every committed row', async () => {
      crashInWalMode(1500);
      const peak = await sampler();
      const d = await start(16);
      const observed = await peak.stop();
      assert.ok(observed.total <= 16 * MIB, `peak ${observed.total}`);
      assert.equal(existsSync(`${env.paths.databaseFile}-wal`), false);
      const plans = await call<unknown[]>(d.app, 'list_plans');
      assert.equal(plans.length, 1500);
    });

    test('startup converts it and then migrates, all within the budget', async () => {
      crashInWalMode(1500);
      const next: Migration = {
        version: MIGRATIONS.length + 1,
        name: 'next',
        sql: 'CREATE INDEX plans_by_title ON plans (title);',
      };
      const peak = await sampler();
      const d = await start(48, [...MIGRATIONS, next]);
      const observed = await peak.stop();
      assert.deepEqual(d.migration.applied, [next.version]);
      assert.ok(observed.total <= 48 * MIB, `peak ${observed.total}`);
      assert.ok(used() <= 48 * MIB);
    });
  });

  test('a crash in the middle of a transaction recovers within the budget', async () => {
    const committed = await start(16);
    await call(committed.app, 'create_plan', { title: 'committed' });
    await committed.close();
    daemon = null;

    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { openDatabase } = await import(${JSON.stringify(new URL('../../src/infrastructure/sqlite/database.ts', import.meta.url).href)});
         const { MIGRATIONS } = await import(${JSON.stringify(new URL('../../src/infrastructure/sqlite/migrations/index.ts', import.meta.url).href)});
         const { db } = openDatabase({ path: process.argv[1], backupDir: process.argv[2], migrations: MIGRATIONS, now: () => new Date(), databaseMaxBytes: 16 * 1024 * 1024 });
         db.exec('BEGIN IMMEDIATE');
         db.exec("UPDATE plans SET description = hex(randomblob(1000))");
         db.exec("INSERT INTO plans (title, description, status, created_at, updated_at) SELECT 'uncommitted', hex(randomblob(1000)), 'active', '', '' FROM plans");
         process.stdout.write('in transaction');
         setInterval(() => {}, 1000);`,
        env.paths.databaseFile,
        env.paths.backupDir,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    for (let i = 0; i < 500 && !output.includes('in transaction'); i++) await sleep(10);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;

    const peak = await sampler();
    const d = await start(16);
    const observed = await peak.stop();
    assert.ok(observed.total <= 16 * MIB, `peak ${observed.total}`);
    const plans = await call<{ title: string; description: string }[]>(d.app, 'list_plans');
    assert.deepEqual(
      plans.map((plan) => [plan.title, plan.description]),
      [['committed', '']],
      'the uncommitted transaction was rolled back',
    );
    assert.equal(measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir).journalBytes, 0);
    await call(d.app, 'create_plan', { title: 'after recovery' });
  });

  test('a crash near the limit leaves the database writable and cleanable', async () => {
    const d0 = await start(5);
    await call(d0.app, 'create_plan', { title: 'P' });
    await fillUntilRefused(d0, 64 * KIB);
    await d0.close();
    daemon = null;

    // Rewrite every page, then die: the hot journal is about as large as the database.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { openDatabase } = await import(${JSON.stringify(new URL('../../src/infrastructure/sqlite/database.ts', import.meta.url).href)});
         const { MIGRATIONS } = await import(${JSON.stringify(new URL('../../src/infrastructure/sqlite/migrations/index.ts', import.meta.url).href)});
         const { db } = openDatabase({ path: process.argv[1], backupDir: process.argv[2], migrations: MIGRATIONS, now: () => new Date(), databaseMaxBytes: 5 * 1024 * 1024 });
         db.exec('BEGIN IMMEDIATE');
         db.exec('UPDATE notes SET body = upper(body)');
         process.stdout.write('in transaction');
         setInterval(() => {}, 1000);`,
        env.paths.databaseFile,
        env.paths.backupDir,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    for (let i = 0; i < 500 && !output.includes('in transaction'); i++) await sleep(10);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    assert.ok(
      measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir).journalBytes > MIB,
      'a large hot journal was left behind',
    );

    const peak = await sampler();
    const d = await start(5);
    assert.equal(
      measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir).journalBytes,
      0,
      'startup truncated the rolled-back journal',
    );
    await call(d.app, 'run_storage_cleanup');
    await call(d.app, 'add_context', { planId: 'P-1', body: 'still writable' });
    const observed = await peak.stop();
    assert.ok(observed.total <= 5 * MIB, `peak ${observed.total}`);
  });

  async function fillToWriteCapacity(d: Daemon): Promise<void> {
    for (const size of [64 * KIB, 4 * KIB, 100]) {
      for (let i = 0; i < 5000; i++) {
        try {
          await call(d.app, 'add_context', { planId: 'P-1', body: 'x'.repeat(size) });
        } catch {
          break;
        }
      }
    }
  }

  /** Releases the database the way a crash would: no shutdown, so no run is recorded. */
  function crash(d: Daemon): void {
    d.store.close();
    daemon = null;
  }

  test('startup recovers a thousand runs at the write capacity, one run per transaction', async () => {
    const d0 = await start(8);
    await call(d0.app, 'create_plan', { title: 'P' });
    const store = d0.app.deps.store;
    const runIds: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const item = await call<{ id: string }>(d0.app, 'create_work_item', {
        planId: 'P-1',
        title: `W ${i}`,
      });
      const run = store.transaction(() =>
        store.runs.insert({
          workItemId: item.id as `W-${number}`,
          profileId: 'fake',
          purpose: 'manual',
          cycleId: null,
          outputRef: `runs/${i}.log`,
          now: new Date().toISOString(),
        }),
      );
      runIds.push(run.id);
    }
    await fillToWriteCapacity(d0);
    const full = await call<{ assessment: { database: { level: string } } }>(
      d0.app,
      'get_storage_status',
    );
    assert.equal(full.assessment.database.level, 'HARD_LIMIT', 'only the reserve is left');
    crash(d0);

    const peak = await sampler();
    const d = await start(8);
    const observed = await peak.stop();
    assert.ok(observed.total <= 8 * MIB, `peak ${observed.total}`);
    const status = await call<{ runningRuns: number }>(d.app, 'get_status');
    assert.equal(status.runningRuns, 0);
    const statuses = new Set(
      runIds.map((id) => d.app.deps.store.runs.get(id as `R-${number}`)?.status),
    );
    assert.deepEqual([...statuses], ['interrupted']);
  });

  async function createRunningRuns(d: Daemon, count: number): Promise<string[]> {
    const store = d.app.deps.store;
    const runIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const item = await call<{ id: `W-${number}` }>(d.app, 'create_work_item', {
        planId: 'P-1',
        title: `W ${i}`,
      });
      const run = store.transaction(() =>
        store.runs.insert({
          workItemId: item.id,
          profileId: 'fake',
          purpose: 'manual',
          cycleId: null,
          outputRef: `runs/${i}.log`,
          now: new Date().toISOString(),
        }),
      );
      runIds.push(run.id);
    }
    return runIds;
  }

  /**
   * Uses up the control reserve too, the way many control operations at HARD_LIMIT would, down
   * to less than `granularity` bytes, so recovery can make some progress before it runs out.
   */
  function exhaustReserve(d: Daemon, granularity: number): void {
    const store = d.app.deps.store;
    for (let i = 0; i < 5000; i++) {
      try {
        store.transaction(
          () =>
            store.notes.insert({
              planId: 'P-1',
              workItemId: null,
              kind: 'context',
              body: 'r'.repeat(granularity),
              now: new Date().toISOString(),
            }),
          'reserve',
        );
      } catch {
        return;
      }
    }
  }

  interface RecoveryStatus {
    runningRuns: number;
    recovery: {
      state: string;
      recoveredRuns: number;
      remainingRuns?: number;
      reason?: string;
      remediation?: string;
    };
  }

  test('a startup recovery that runs out of reserve leaves a degraded but usable daemon', async () => {
    const d0 = await start(8);
    await call(d0.app, 'create_plan', { title: 'P' });
    const runIds = await createRunningRuns(d0, 1000);
    await fillToWriteCapacity(d0);
    exhaustReserve(d0, 16 * KIB);
    crash(d0);

    const peak = await sampler();
    const d = await start(8);
    const status = await call<RecoveryStatus>(d.app, 'get_status');
    assert.equal(status.recovery.state, 'incomplete');
    assert.equal(status.recovery.reason, 'STORAGE_HARD_LIMIT');
    const remaining = status.recovery.remainingRuns ?? 0;
    assert.ok(remaining > 0);
    assert.ok(status.recovery.recoveredRuns > 0, 'recovery made progress before running out');
    assert.equal(status.recovery.recoveredRuns + remaining, runIds.length);
    assert.equal(status.runningRuns, remaining, 'unrecovered runs stay running');
    assert.match(status.recovery.remediation ?? '', /storage\.database_max_mb/);

    // Inspection and maintenance work.
    await call(d.app, 'get_storage_status');
    await call(d.app, 'get_schema_status');
    await call(d.app, 'list_plans');
    await call(d.app, 'get_plan', { planId: 'P-1' });
    const items = await call<{ id: string }[]>(d.app, 'list_work_items');
    await call(d.app, 'get_work_item', { workItemId: items[0]?.id });
    await call(d.app, 'run_storage_cleanup');

    // New work is refused with the reason, and so is pausing an unrecovered run's Work Item.
    const stillRunning = runIds.find(
      (id) => d.app.deps.store.runs.get(id as `R-${number}`)?.status === 'running',
    );
    const owner = d.app.deps.store.runs.get(stillRunning as `R-${number}`)?.workItemId;
    const refused = await rejectsWith(
      call(d.app, 'start_run', { workItemId: owner, profileId: 'fake', instructions: 'go' }),
      'RECOVERY_INCOMPLETE',
    );
    assert.match(refused.message, /storage\.database_max_mb/);
    await rejectsWith(call(d.app, 'create_plan', { title: 'new' }), 'RECOVERY_INCOMPLETE');
    await rejectsWith(call(d.app, 'pause_work_item', { workItemId: owner }), 'RECOVERY_INCOMPLETE');
    const observed = await peak.stop();
    assert.ok(observed.total <= 8 * MIB, `peak ${observed.total}`);

    // Remediation: a larger budget and a restart complete the recovery.
    const recoveredBefore = new Map(
      runIds
        .map((id) => d.app.deps.store.runs.get(id as `R-${number}`))
        .filter((run) => run?.status === 'interrupted')
        .map((run) => [run?.id, run?.finishedAt]),
    );
    await d.close();
    daemon = null;
    const restarted = await start(16);
    const after = await call<RecoveryStatus>(restarted.app, 'get_status');
    assert.equal(after.recovery.state, 'complete');
    assert.equal(after.runningRuns, 0);
    for (const [id, finishedAt] of recoveredBefore) {
      assert.equal(
        restarted.app.deps.store.runs.get(id as `R-${number}`)?.finishedAt,
        finishedAt,
        'runs recovered earlier are not rewritten',
      );
    }
    await call(restarted.app, 'create_plan', { title: 'writable again' });
  });

  test('recovery that stopped halfway finishes on the next start', async () => {
    const d0 = await start(16);
    await call(d0.app, 'create_plan', { title: 'P' });
    const store = d0.app.deps.store;
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const item = await call<{ id: `W-${number}` }>(d0.app, 'create_work_item', {
        planId: 'P-1',
        title: `W ${i}`,
      });
      runs.push(
        store.transaction(() =>
          store.runs.insert({
            workItemId: item.id,
            profileId: 'fake',
            purpose: 'manual',
            cycleId: null,
            outputRef: `runs/halfway-${i}.log`,
            now: '2026-01-01T00:00:00.000Z',
          }),
        ),
      );
    }
    const [first, second, third] = runs;
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    // As if the previous recovery had committed only the first run before dying.
    store.transaction(
      () => store.runs.markInterrupted(first.id, '2026-01-02T00:00:00.000Z'),
      'reserve',
    );
    crash(d0);

    const d = await start(16);
    const after = [first, second, third].map((run) => d.app.deps.store.runs.get(run.id));
    assert.deepEqual(
      after.map((run) => run?.status),
      ['interrupted', 'interrupted', 'interrupted'],
    );
    assert.equal(
      after[0]?.finishedAt,
      '2026-01-02T00:00:00.000Z',
      'already recovered runs are left as they were',
    );
  });

  test('sorting and multi-row changes create no files in the OS temporary directory', async () => {
    const watched = join(env.root, 'sqlite-temp');
    mkdirSync(watched);
    const watcher = spawn(
      process.execPath,
      [
        '-e',
        `let events = 0;
         require('node:fs').watch(process.argv[1], () => events++);
         process.stdout.write('ready');
         process.on('SIGTERM', () => { process.stdout.write(' ' + events); process.exit(0); });
         setInterval(() => {}, 1000);`,
        watched,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let output = '';
    watcher.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    for (let i = 0; i < 500 && !output.includes('ready'); i++) await sleep(10);

    const workload = (db: DatabaseSync) => {
      // temp_store_directory is deprecated but still the only way to point SQLite's temporary
      // files at a directory this test can watch.
      db.exec(`PRAGMA temp_store_directory = '${watched}'`);
      db.exec('CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, k TEXT, v BLOB)');
      db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000)
               INSERT INTO big (k, v) SELECT hex(randomblob(8)), randomblob(3000) FROM n`);
      db.prepare('SELECT v FROM big ORDER BY v').all();
      db.prepare('SELECT DISTINCT v FROM big').all();
      db.prepare('SELECT k, count(*) FROM big GROUP BY k').all();
      db.exec('BEGIN IMMEDIATE');
      db.exec('UPDATE big SET k = k || 1');
      db.exec('COMMIT');
    };

    const { db } = openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations: MIGRATIONS,
      now: () => new Date(),
      databaseMaxBytes: 128 * MIB,
    });
    try {
      workload(db);
    } finally {
      db.close();
    }
    await sleep(200);
    const orviaEvents = output;

    // The same workload with SQLite's default temp_store must create temporary files, or this
    // test would not be able to see them at all.
    const control = new DatabaseSync(join(env.root, 'control.db'));
    control.exec('PRAGMA temp_store = FILE');
    workload(control);
    control.close();
    await sleep(200);
    const exited = new Promise((resolve) => watcher.once('exit', resolve));
    watcher.kill('SIGTERM');
    await exited;
    const total = Number(output.trim().split(' ').at(-1));

    assert.equal(orviaEvents, 'ready', 'no temporary file was created with temp_store = MEMORY');
    assert.ok(total > 0, 'the control run did create temporary files');
  });

  test('refusals explain the limit and the remedy', async () => {
    const d = await start(5);
    await call(d.app, 'create_plan', { title: 'P' });
    await fillUntilRefused(d, 64 * KIB);
    for (let i = 0; i < 2000; i++) {
      try {
        await call(d.app, 'add_context', { planId: 'P-1', body: 'x'.repeat(100) });
      } catch {
        break;
      }
    }
    const error = await rejectsWith(
      call(d.app, 'create_plan', { title: 'more' }),
      'STORAGE_HARD_LIMIT',
    );
    assert.match(error.message, /storage\.database_max_mb/);
    const database = error.details['database'] as Record<string, number>;
    assert.equal(database['limitBytes'], 5 * MIB);
    assert.ok(Number(database['usedBytes']) <= 5 * MIB);
    assert.equal(error.details['operationClass'], 'write');
  });
});
