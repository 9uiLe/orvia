import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OrviaError } from '../../domain/errors.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationReport {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
  readonly backupPath: string | null;
}

export interface DatabaseHeader {
  readonly userVersion: number;
  readonly applicationId: number;
  readonly pageCount: number;
}

/** "ORVI" in ASCII; marks the file as an Orvia database in the SQLite header. */
export const ORVIA_APPLICATION_ID = 0x4f525649;
export const HISTORY_TABLE = 'orvia_schema_migrations';
const BACKUP_PREFIX = 'state-';

export function checksumOf(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex');
}

export function latestVersion(migrations: readonly Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}

export function validateMigrationList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new OrviaError('INTERNAL', 'migration versions must be consecutive from 1', {
        expected: index + 1,
        actual: migration.version,
      });
    }
  });
}

function pragmaNumber(db: DatabaseSync, pragma: string): number {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value !== 'number') {
    throw new OrviaError('INTERNAL', `PRAGMA ${pragma} returned a non-number`);
  }
  return value;
}

/** Reads header fields only. Nothing is written, so a rejected database stays byte-identical. */
export function readHeader(db: DatabaseSync): DatabaseHeader {
  return {
    userVersion: pragmaNumber(db, 'user_version'),
    applicationId: pragmaNumber(db, 'application_id'),
    pageCount: pragmaNumber(db, 'page_count'),
  };
}

export function assertCompatible(header: DatabaseHeader, supportedVersion: number): void {
  if (header.pageCount === 0) return;
  if (header.applicationId !== ORVIA_APPLICATION_ID) {
    throw new OrviaError('NOT_AN_ORVIA_DATABASE', 'the database file was not created by Orvia', {
      applicationId: header.applicationId,
    });
  }
  if (header.userVersion > supportedVersion) {
    throw new OrviaError(
      'UNSUPPORTED_DATABASE_VERSION',
      `database schema v${header.userVersion} is newer than this Orvia build supports (v${supportedVersion}); upgrade Orvia`,
      { databaseVersion: header.userVersion, supportedVersion },
    );
  }
}

/** Settings that must be in place before the first table exists. */
export function initializeFreshDatabase(db: DatabaseSync): void {
  // auto_vacuum first: writing application_id creates page 1, after which auto_vacuum can no
  // longer change without a full VACUUM.
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec(`PRAGMA application_id = ${ORVIA_APPLICATION_ID}`);
}

function historyExists(db: DatabaseSync): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(HISTORY_TABLE) !== undefined
  );
}

export interface HistoryRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export function readHistory(db: DatabaseSync): HistoryRow[] {
  if (!historyExists(db)) return [];
  return db
    .prepare(
      `SELECT version, name, checksum, applied_at AS appliedAt FROM ${HISTORY_TABLE} ORDER BY version`,
    )
    .all() as unknown as HistoryRow[];
}

function verifyHistory(db: DatabaseSync, migrations: readonly Migration[], userVersion: number) {
  const history = readHistory(db);
  if ((history.at(-1)?.version ?? 0) !== userVersion) {
    throw new OrviaError(
      'DATABASE_INTEGRITY_FAILED',
      'migration history does not match the schema version in the database header',
      { userVersion, historyVersion: history.at(-1)?.version ?? 0 },
    );
  }
  for (const row of history) {
    const known = migrations[row.version - 1];
    if (known === undefined || checksumOf(known) !== row.checksum) {
      throw new OrviaError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `applied migration v${row.version} differs from the migration shipped with this build`,
        { version: row.version },
      );
    }
  }
}

export function integrityCheck(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const messages = rows.map((row) => String(Object.values(row)[0]));
  if (messages.length !== 1 || messages[0] !== 'ok') {
    throw new OrviaError('DATABASE_INTEGRITY_FAILED', 'PRAGMA integrity_check failed', {
      problems: messages.slice(0, 10),
    });
  }
}

function timestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Writes a consistent copy and keeps only the newest backup. */
export function backupDatabase(
  db: DatabaseSync,
  backupDir: string,
  fromVersion: number,
  now: Date,
): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const fileName = `${BACKUP_PREFIX}v${fromVersion}-${timestampForFile(now)}.db`;
  const finalPath = join(backupDir, fileName);
  const partialPath = `${finalPath}.partial`;
  rmSync(partialPath, { force: true });
  db.prepare('VACUUM INTO ?').run(partialPath);
  renameSync(partialPath, finalPath);
  for (const entry of readdirSync(backupDir)) {
    if (entry.startsWith(BACKUP_PREFIX) && entry !== fileName) {
      rmSync(join(backupDir, entry), { force: true });
    }
  }
  return finalPath;
}

export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: { backupDir: string; now: () => Date },
): MigrationReport {
  validateMigrationList(migrations);
  const fromVersion = readHeader(db).userVersion;
  verifyHistory(db, migrations, fromVersion);
  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };
  }

  let backupPath: string | null = null;
  if (fromVersion > 0) {
    integrityCheck(db);
    backupPath = backupDatabase(db, options.backupDir, fromVersion, options.now());
  }

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT`,
      );
      db.prepare(
        `INSERT INTO ${HISTORY_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
      ).run(migration.version, migration.name, checksumOf(migration), options.now().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new OrviaError(
        'MIGRATION_FAILED',
        `migration v${migration.version} (${migration.name}) failed and was rolled back`,
        {
          version: migration.version,
          cause: error instanceof Error ? error.message : String(error),
          backupPath,
        },
      );
    }
  }
  integrityCheck(db);
  return {
    fromVersion,
    toVersion: latestVersion(migrations),
    applied: pending.map((migration) => migration.version),
    backupPath,
  };
}
