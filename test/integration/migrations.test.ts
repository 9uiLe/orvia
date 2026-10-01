import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { ORVIA_APPLICATION_ID, type Migration } from '../../src/infrastructure/sqlite/migrator.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import { call, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { ManualClock, makeTestEnv, type TestEnv } from '../helpers/env.ts';

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

  function open(migrations: readonly Migration[]) {
    return openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations,
      now: () => clock.now(),
    });
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
      assert.equal(pragma(db, 'journal_mode'), 'wal');
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
});
