import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OrviaError } from '../../domain/errors.ts';
import type { DatabaseUsage } from '../../domain/storage.ts';
import { measureDatabaseFiles } from './database-files.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  /**
   * Bytes the migration may add to the main database file (data backfills, table rebuilds).
   * Used only for the storage preflight; growth beyond the budget is stopped by
   * max_page_count either way.
   */
  readonly headroomBytes?: number;
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

const PARTIAL_SUFFIX = '.partial';
const SQLITE_FULL = 13;

/** A rollback-journal record is the page plus a 4-byte page number and a 4-byte checksum. */
const JOURNAL_RECORD_OVERHEAD = 8;

export interface MigrationBudget {
  /** `storage.database_max_mb` in bytes: database, WAL, SHM, journal, and backups together. */
  readonly databaseMaxBytes: number;
  /** Space kept free for maintenance after the migration (one WAL checkpoint interval). */
  readonly reserveBytes: number;
}

export interface MigrationStoragePlan {
  readonly configuredLimitBytes: number;
  readonly currentUsageBytes: number;
  readonly databaseBytes: number;
  readonly journalBoundBytes: number;
  readonly newBackupBytes: number;
  readonly existingBackupBytes: number;
  readonly reserveBytes: number;
  readonly estimatedRequiredTotalBytes: number;
  readonly requiredAdditionalBytes: number;
  /** max_page_count for the main database while migrating. */
  readonly maxPageCount: number;
}

/**
 * Worst-case storage for applying migrations in rollback-journal mode, which bounds every
 * file involved:
 * - main database: at most `maxPageCount` pages (enforced by max_page_count);
 * - rollback journal: each page that existed when a transaction began is journaled at most
 *   once, so at most `maxPageCount` records plus a header;
 * - new backup: `VACUUM INTO` copies only the pages in use;
 * - existing backups, SHM, and the maintenance reserve are added as they are.
 * The page cap is the largest that fits the budget; the migration needs at least its current
 * size plus the declared headroom.
 */
export function planMigrationStorage(input: {
  readonly usage: DatabaseUsage;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly headroomBytes: number;
  readonly needsBackup: boolean;
  readonly budget: MigrationBudget;
}): MigrationStoragePlan {
  const { usage, pageSize, budget } = input;
  const perPage = pageSize + pageSize + JOURNAL_RECORD_OVERHEAD;
  const journalHeader = pageSize;
  const newBackupBytes = input.needsBackup ? (input.pageCount - input.freelistCount) * pageSize : 0;
  const fixedBytes =
    usage.backupBytes + newBackupBytes + usage.shmBytes + budget.reserveBytes + journalHeader;
  const neededPages = input.pageCount + Math.ceil(input.headroomBytes / pageSize);
  const estimatedRequiredTotalBytes = fixedBytes + neededPages * perPage;
  const currentUsageBytes =
    usage.mainBytes + usage.walBytes + usage.shmBytes + usage.journalBytes + usage.backupBytes;
  return {
    configuredLimitBytes: budget.databaseMaxBytes,
    currentUsageBytes,
    databaseBytes: neededPages * pageSize,
    journalBoundBytes: journalHeader + neededPages * (pageSize + JOURNAL_RECORD_OVERHEAD),
    newBackupBytes,
    existingBackupBytes: usage.backupBytes,
    reserveBytes: budget.reserveBytes,
    estimatedRequiredTotalBytes,
    requiredAdditionalBytes: Math.max(0, estimatedRequiredTotalBytes - currentUsageBytes),
    maxPageCount: Math.max(0, Math.floor((budget.databaseMaxBytes - fixedBytes) / perPage)),
  };
}

function storageError(message: string, plan: MigrationStoragePlan, extra: object = {}) {
  return new OrviaError('MIGRATION_STORAGE_REQUIRED', message, {
    ...plan,
    configKey: 'storage.database_max_mb',
    ...extra,
  });
}

function removePartialBackups(backupDir: string): void {
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (name.endsWith(PARTIAL_SUFFIX)) rmSync(join(backupDir, name), { force: true });
  }
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
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;
  try {
    db.prepare('VACUUM INTO ?').run(partialPath);
    renameSync(partialPath, finalPath);
  } finally {
    rmSync(partialPath, { force: true });
  }
  for (const entry of readdirSync(backupDir)) {
    if (entry.startsWith(BACKUP_PREFIX) && entry !== fileName) {
      rmSync(join(backupDir, entry), { force: true });
    }
  }
  return finalPath;
}

function errcode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return null;
  return typeof error.errcode === 'number' ? error.errcode & 0xff : null;
}

/**
 * Applies pending migrations without letting Orvia's files exceed the database budget at any
 * point. The capacity check runs before anything is written. Migrations run in
 * rollback-journal mode because, unlike WAL, its size is bounded by the database size; the
 * caller switches back to WAL afterwards.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: { backupDir: string; now: () => Date; budget: MigrationBudget },
): MigrationReport {
  validateMigrationList(migrations);
  const fromVersion = readHeader(db).userVersion;
  verifyHistory(db, migrations, fromVersion);
  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };
  }

  const databasePath = db.location();
  if (databasePath === null) throw new OrviaError('INTERNAL', 'migrations need a file database');
  // Partial backups are leftovers of an interrupted backup; they never hold a usable copy.
  removePartialBackups(options.backupDir);

  const plan = planMigrationStorage({
    usage: measureDatabaseFiles(databasePath, options.backupDir),
    pageSize: pragmaNumber(db, 'page_size'),
    pageCount: pragmaNumber(db, 'page_count'),
    freelistCount: pragmaNumber(db, 'freelist_count'),
    headroomBytes: pending.reduce((sum, migration) => sum + (migration.headroomBytes ?? 0), 0),
    needsBackup: fromVersion > 0,
    budget: options.budget,
  });
  if (plan.estimatedRequiredTotalBytes > plan.configuredLimitBytes) {
    throw storageError(
      `migrating needs up to ${mib(plan.estimatedRequiredTotalBytes)} MiB but storage.database_max_mb ` +
        `is ${mib(plan.configuredLimitBytes)} MiB (${mib(plan.currentUsageBytes)} MiB in use). ` +
        `Raise storage.database_max_mb, or remove old backups in ${options.backupDir}. ` +
        'Nothing was changed.',
      plan,
      { backupDir: options.backupDir },
    );
  }

  // Switching checkpoints the WAL into the main file; page_count above already included it.
  if (pragmaText(db, 'journal_mode = DELETE') !== 'delete') {
    throw new OrviaError('INTERNAL', 'could not switch to rollback-journal mode for migrations');
  }
  let backupPath: string | null = null;
  if (fromVersion > 0) {
    integrityCheck(db);
    backupPath = backupDatabase(db, options.backupDir, fromVersion, options.now());
  }

  db.exec(`PRAGMA max_page_count = ${plan.maxPageCount}`);
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
      if (errcode(error) === SQLITE_FULL) {
        throw storageError(
          `migration v${migration.version} (${migration.name}) grew beyond the database budget ` +
            'and was rolled back; raise storage.database_max_mb',
          plan,
          { version: migration.version, backupPath },
        );
      }
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

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function pragmaText(db: DatabaseSync, pragma: string): string {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return String(row === undefined ? '' : Object.values(row)[0]);
}
