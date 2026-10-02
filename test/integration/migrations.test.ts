import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { OrviaError } from '../../src/domain/errors.ts';
import { databaseUsedBytes } from '../../src/domain/storage.ts';
import { measureDatabaseFiles } from '../../src/infrastructure/sqlite/database-files.ts';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import {
  countSchemaBtrees,
  ORVIA_APPLICATION_ID,
  planMigrationStorage,
  type Migration,
} from '../../src/infrastructure/sqlite/migrator.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import { call, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { ManualClock, makeTestEnv, type TestEnv } from '../helpers/env.ts';

const MIB = 1024 * 1024;

const v1: Migration = {
  version: 1,
  name: 'items',
  sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;',
};
const v2: Migration = {
  version: 2,
  name: 'items_note',
  sql: "ALTER TABLE items ADD COLUMN note TEXT NOT NULL DEFAULT '';",
};
const v3: Migration = {
  version: 3,
  name: 'tags',
  sql: 'CREATE TABLE tags (id INTEGER PRIMARY KEY) STRICT;',
};
const broken: Migration = {
  version: 2,
  name: 'broken',
  sql: 'CREATE TABLE half_done (id INTEGER PRIMARY KEY); INSERT INTO no_such_table VALUES (1);',
};

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('database migrations', () => {
  let env: TestEnv;
  let clock: ManualClock;

  beforeEach(() => {
    env = makeTestEnv();
    clock = new ManualClock();
    mkdirSync(env.paths.dataDir, { recursive: true });
  });
  afterEach(() => {
    env.cleanup();
  });

  function open(migrations: readonly Migration[], databaseMaxBytes = 128 * MIB) {
    return openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations,
      now: () => clock.now(),
      databaseMaxBytes,
    });
  }

  /** Creates a v1 database holding roughly `bytes` of data. */
  function seed(bytes: number): void {
    const opened = open([v1]);
    opened.db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO items (name) SELECT hex(randomblob(1000)) FROM n`,
      )
      .run(Math.ceil(bytes / 2000));
    opened.db.close();
  }

  function usedBytes(): number {
    return databaseUsedBytes(measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir));
  }

  function userVersion(): number {
    const db = new DatabaseSync(env.paths.databaseFile);
    try {
      return Number(pragma(db, 'user_version'));
    } finally {
      db.close();
    }
  }

  function migrationError(fn: () => unknown): OrviaError {
    try {
      fn();
    } catch (error) {
      if (error instanceof OrviaError) return error;
      throw error;
    }
    throw new Error('expected the migration to fail');
  }

  function pragma(db: DatabaseSync, name: string): unknown {
    return Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0];
  }

  function backups(): string[] {
    try {
      return readdirSync(env.paths.backupDir);
    } catch {
      return [];
    }
  }

  test('fresh database → latest shipped schema', async () => {
    const daemon = await startTestDaemon(env, { clock });
    try {
      assert.deepEqual(
        daemon.migration.applied,
        MIGRATIONS.map((m) => m.version),
      );
      assert.equal(daemon.migration.backupPath, null, 'nothing to back up on a fresh database');
      const schema = await call<{ databaseVersion: number; supportedVersion: number }>(
        daemon.app,
        'get_schema_status',
      );
      assert.equal(schema.databaseVersion, schema.supportedVersion);
    } finally {
      await daemon.close();
    }
    const db = new DatabaseSync(env.paths.databaseFile);
    try {
      assert.equal(pragma(db, 'auto_vacuum'), 2, 'auto_vacuum is INCREMENTAL');
      assert.equal(pragma(db, 'journal_mode'), 'delete');
      assert.equal(pragma(db, 'application_id'), ORVIA_APPLICATION_ID);
      const history = db
        .prepare('SELECT version, checksum, applied_at FROM orvia_schema_migrations')
        .all();
      assert.equal(history.length, MIGRATIONS.length);
      assert.ok(
        history.every((row) => typeof row['checksum'] === 'string' && row['applied_at'] !== null),
      );
    } finally {
      db.close();
    }
  });

  test('old schema → latest keeps data and takes a backup first', () => {
    const first = open([v1]);
    first.db.exec("INSERT INTO items (name) VALUES ('kept')");
    first.db.close();

    clock.advanceDays(1);
    const second = open([v1, v2]);
    try {
      assert.deepEqual(second.migration.applied, [2]);
      assert.equal(second.migration.fromVersion, 1);
      assert.deepEqual(
        second.db
          .prepare('SELECT name, note FROM items')
          .all()
          .map((r) => ({ ...r })),
        [{ name: 'kept', note: '' }],
      );
      assert.ok(second.migration.backupPath !== null);
    } finally {
      second.db.close();
    }
    const backup = new DatabaseSync(second.migration.backupPath, { readOnly: true });
    try {
      assert.equal(pragma(backup, 'user_version'), 1, 'the backup holds the pre-migration schema');
      assert.equal(backup.prepare('SELECT count(*) AS n FROM items').get()?.['n'], 1);
    } finally {
      backup.close();
    }
  });

  test('shipped 0001 data → 0002 orchestration: existing runs become manual runs', async () => {
    const first = open(MIGRATIONS.slice(0, 1));
    const at = '2026-01-01T00:00:00.000Z';
    first.db.exec(`
      INSERT INTO plans VALUES (1, 'P', '', 'active', '${at}', '${at}');
      INSERT INTO work_items (id, plan_id, title, description, status, created_at, updated_at)
        VALUES (1, 1, 'W', '', 'active', '${at}', '${at}');
      INSERT INTO runs (id, work_item_id, agent, status, exit_code, output_ref, started_at, finished_at)
        VALUES (1, 1, 'codex', 'succeeded', 0, 'runs/old.log', '${at}', '${at}');
    `);
    first.db.close();

    const daemon = await startTestDaemon(env, { clock });
    try {
      assert.deepEqual(daemon.migration.applied, [2]);
      const runs = await call<{ runs: { id: string; purpose: string; cycleId: unknown }[] }>(
        daemon.app,
        'get_work_item',
        { workItemId: 'W-1' },
      );
      assert.deepEqual(
        runs.runs.map((run) => [run.id, run.purpose, run.cycleId]),
        [['R-1', 'manual', null]],
      );
      const status = await call<{ openWorkItems: { cycle: unknown }[] }>(daemon.app, 'get_status');
      assert.equal(status.openWorkItems[0]?.cycle, null);
    } finally {
      await daemon.close();
    }
  });

  test('a failing migration rolls back completely', () => {
    open([v1]).db.close();
    const before = new DatabaseSync(env.paths.databaseFile);
    before.exec("INSERT INTO items (name) VALUES ('before')");
    before.close();

    const error = (() => {
      try {
        open([v1, broken]);
      } catch (caught) {
        return caught as { code: string };
      }
      return null;
    })();
    assert.equal(error?.code, 'MIGRATION_FAILED');

    const db = new DatabaseSync(env.paths.databaseFile);
    try {
      assert.equal(pragma(db, 'user_version'), 1);
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
      assert.ok(!tables.some((row) => row['name'] === 'half_done'), 'partial DDL was rolled back');
      assert.equal(db.prepare('SELECT count(*) AS n FROM orvia_schema_migrations').get()?.['n'], 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM items').get()?.['n'], 1);
    } finally {
      db.close();
    }
    const retry = open([v1, v2]);
    assert.deepEqual(retry.migration.applied, [2], 'a fixed migration applies afterwards');
    retry.db.close();
  });

  test('a database newer than the binary is rejected without being modified', async () => {
    open([v1, v2]).db.close();
    const hash = sha256(env.paths.databaseFile);
    const databaseFiles = () =>
      readdirSync(env.paths.dataDir)
        .filter((name) => name.startsWith('state.db'))
        .sort();
    const files = databaseFiles();

    assert.throws(() => open([v1]), { code: 'UNSUPPORTED_DATABASE_VERSION' });
    await rejectsWith(startTestDaemon(env, { migrations: [v1] }), 'UNSUPPORTED_DATABASE_VERSION');

    assert.equal(sha256(env.paths.databaseFile), hash, 'database bytes are unchanged');
    assert.deepEqual(databaseFiles(), files);
    assert.deepEqual(backups(), []);
  });

  test('an edited migration that was already applied is rejected', () => {
    open([v1]).db.close();
    const edited = { ...v1, sql: `${v1.sql} -- edited` };
    assert.throws(() => open([edited]), { code: 'MIGRATION_CHECKSUM_MISMATCH' });
  });

  test('a database file that Orvia did not create is rejected', () => {
    const foreign = new DatabaseSync(env.paths.databaseFile);
    foreign.exec('CREATE TABLE something (x)');
    foreign.close();
    assert.throws(() => open(MIGRATIONS), { code: 'NOT_AN_ORVIA_DATABASE' });
  });

  test('only the newest migration backup is retained', () => {
    open([v1]).db.close();
    clock.advanceDays(1);
    open([v1, v2]).db.close();
    clock.advanceDays(1);
    const third = open([v1, v2, v3]);
    third.db.close();
    assert.equal(backups().length, 1);
    assert.equal(`${env.paths.backupDir}/${backups()[0] ?? ''}`, third.migration.backupPath);
    assert.match(backups()[0] ?? '', /^state-v2-/);
  });

  test('migration backups count toward the database storage budget', async () => {
    open(MIGRATIONS).db.close();
    const next: Migration = {
      version: MIGRATIONS.length + 1,
      name: 'next',
      sql: 'CREATE TABLE next_feature (id INTEGER PRIMARY KEY) STRICT;',
    };
    const daemon = await startTestDaemon(env, { migrations: [...MIGRATIONS, next] });
    try {
      const status = await call<{ usage: { database: { backupBytes: number } } }>(
        daemon.app,
        'get_storage_status',
      );
      assert.ok(status.usage.database.backupBytes > 0);
    } finally {
      await daemon.close();
    }
  });
  describe('storage budget', () => {
    test('enough capacity for database, journal, backup, and reserve: migration succeeds', () => {
      seed(2 * MIB);
      const before = new DatabaseSync(env.paths.databaseFile);
      const pagesInUse =
        Number(pragma(before, 'page_count')) - Number(pragma(before, 'freelist_count'));
      const pageSize = Number(pragma(before, 'page_size'));
      before.close();
      const migrated = open([v1, v2], 16 * MIB);
      try {
        assert.deepEqual(migrated.migration.applied, [2]);
        assert.ok(migrated.migration.backupPath !== null);
        assert.equal(pragma(migrated.db, 'journal_mode'), 'delete');
        assert.ok(
          statSync(migrated.migration.backupPath).size <= pagesInUse * pageSize,
          'the backup fits the preflight estimate (pages in use × page size)',
        );
      } finally {
        migrated.db.close();
      }
      assert.ok(usedBytes() <= 16 * MIB);
    });

    test('a backup that would not fit is refused before anything changes', () => {
      seed(2 * MIB);
      const partial = join(env.paths.backupDir, 'state-v1-interrupted.db.partial');
      mkdirSync(env.paths.backupDir, { recursive: true });
      writeFileSync(partial, Buffer.alloc(1000));

      const error = migrationError(() => open([v1, v2], 6 * MIB));
      assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
      const detail = (key: string) => Number(error.details[key]);
      assert.equal(detail('configuredLimitBytes'), 6 * MIB);
      assert.ok(detail('estimatedRequiredTotalBytes') > 6 * MIB);
      assert.equal(
        detail('requiredAdditionalBytes'),
        detail('estimatedRequiredTotalBytes') - detail('currentUsageBytes'),
      );
      assert.equal(detail('currentUsageBytes'), usedBytes());

      assert.equal(userVersion(), 1, 'schema unchanged');
      assert.deepEqual(backups(), [], 'no backup and no partial backup left behind');
    });

    test('existing backups count toward the budget', () => {
      seed(2 * MIB);
      mkdirSync(env.paths.backupDir, { recursive: true });
      const old = join(env.paths.backupDir, 'state-v0-earlier.db');
      writeFileSync(old, Buffer.alloc(4 * MIB));

      const error = migrationError(() => open([v1, v2], 10 * MIB));
      assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
      assert.equal((error.details as Record<string, number>)['existingBackupBytes'], 4 * MIB);
      assert.equal(userVersion(), 1);

      rmSync(old);
      const migrated = open([v1, v2], 10 * MIB);
      migrated.db.close();
      assert.equal(userVersion(), 2, 'the same budget suffices without the old backup');
    });

    test('a migration that grows past the budget at run time is stopped and rolled back', () => {
      seed(2 * MIB);
      const grows: Migration = {
        version: 2,
        name: 'backfill',
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
              INSERT INTO items (name) SELECT hex(randomblob(1000)) FROM n;`,
      };
      const error = migrationError(() => open([v1, grows], 16 * MIB));
      assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
      assert.equal(userVersion(), 1);
      assert.ok(usedBytes() <= 16 * MIB, 'files stayed within the budget');
      assert.equal(backups().length, 1, 'the backup is kept for recovery');
    });

    test('declared migration headroom is part of the preflight', () => {
      seed(2 * MIB);
      const declared: Migration = { ...v2, headroomBytes: 20 * MIB };
      const error = migrationError(() => open([v1, declared], 16 * MIB));
      assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
      assert.deepEqual(backups(), [], 'refused before the backup was written');
    });

    test('a failing migration keeps the backup, and storage accounting includes it', () => {
      seed(2 * MIB);
      const error = migrationError(() => open([v1, broken], 16 * MIB));
      assert.equal(error.code, 'MIGRATION_FAILED');
      assert.equal(userVersion(), 1);

      const backupPath = String(error.details['backupPath']);
      const backup = new DatabaseSync(backupPath, { readOnly: true });
      try {
        assert.equal(pragma(backup, 'user_version'), 1);
        assert.ok(Number(backup.prepare('SELECT count(*) AS n FROM items').get()?.['n']) > 0);
      } finally {
        backup.close();
      }
      const usage = measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir);
      assert.equal(usage.backupBytes, statSync(backupPath).size);
      assert.ok(databaseUsedBytes(usage) <= 16 * MIB);
    });

    describe('control reserve after the schema grows', () => {
      const tables = (from: number, count: number) =>
        Array.from(
          { length: count },
          (_, k) =>
            `CREATE TABLE extra_${from + k} (id INTEGER PRIMARY KEY, v TEXT) STRICT;
             CREATE INDEX extra_${from + k}_v ON extra_${from + k} (v);`,
        ).join('\n');

      /** The smallest budget the storage preflight accepts for migrating `seed` data. */
      function tightBudget(): number {
        const db = new DatabaseSync(env.paths.databaseFile);
        try {
          const read = (name: string) => Number(pragma(db, name));
          let budget = 4 * MIB;
          for (let i = 0; i < 5; i++) {
            budget = planMigrationStorage({
              usage: measureDatabaseFiles(env.paths.databaseFile, env.paths.backupDir),
              pageSize: read('page_size'),
              pageCount: read('page_count'),
              freelistCount: read('freelist_count'),
              btreeCount: countSchemaBtrees(db),
              headroomBytes: 0,
              needsBackup: true,
              budgetBytes: budget,
            }).estimatedRequiredTotalBytes;
          }
          return budget;
        } finally {
          db.close();
        }
      }

      function btrees(): number {
        const db = new DatabaseSync(env.paths.databaseFile);
        try {
          return countSchemaBtrees(db);
        } finally {
          db.close();
        }
      }

      test('new tables and indexes that still leave the reserve are committed', () => {
        seed(MIB);
        const before = btrees();
        const grows: Migration = { version: 2, name: 'more_tables', sql: tables(0, 2) };
        open([v1, grows], 16 * MIB).db.close();
        assert.equal(userVersion(), 2);
        assert.equal(btrees(), before + 4);
      });

      test('a migration whose new b-trees eat the reserve is rolled back before COMMIT', () => {
        seed(MIB);
        const before = btrees();
        const budget = tightBudget();
        // Few enough new pages to fit under the migration's page cap; enough new b-trees that
        // the larger reserve no longer fits.
        const grows: Migration = { version: 2, name: 'many_tables', sql: tables(0, 3) };

        const error = migrationError(() => open([v1, grows], budget));
        assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
        const detail = (key: string) => error.details[key];
        assert.equal(detail('version'), 2);
        assert.equal(detail('name'), 'many_tables');
        assert.equal(detail('configuredLimitBytes'), budget);
        assert.equal(detail('postMigrationBtreeCount'), before + 6);
        assert.ok(Number(detail('postMigrationPageCount')) > Number(detail('writeMaxPages')));
        assert.ok(Number(detail('maxPages')) > Number(detail('writeMaxPages')));
        assert.ok(Number(detail('requiredAdditionalBytes')) > 0);

        assert.equal(backups().length, 1, 'the preflight passed and the backup was written');
        assert.equal(userVersion(), 1);
        assert.equal(btrees(), before, 'no new table or index remains');
        assert.ok(usedBytes() <= budget);
      });

      test('in a chain, migrations before the one that does not fit stay applied', () => {
        seed(MIB);
        const db = new DatabaseSync(env.paths.databaseFile);
        const pageSize = Number(pragma(db, 'page_size'));
        db.close();
        // Room for one more small table's reserve, not for six more b-trees.
        const budget = tightBudget() + 40 * (2 * pageSize + 8);
        const small: Migration = { version: 2, name: 'one_table', sql: tables(0, 1) };
        const large: Migration = { version: 3, name: 'many_tables', sql: tables(1, 3) };

        const error = migrationError(() => open([v1, small, large], budget));
        assert.equal(error.code, 'MIGRATION_STORAGE_REQUIRED');
        assert.equal(error.details['version'], 3);
        assert.equal(userVersion(), 2, 'each migration commits on its own');
        assert.ok(usedBytes() <= budget);
      });
    });
  });
});
