import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isOrviaError, OrviaError } from '../../domain/errors.ts';
import {
  databaseCapacity,
  databaseUsedBytes,
  JOURNAL_HEADER_BYTES,
  JOURNAL_RECORD_OVERHEAD_BYTES,
  journalPerPageBytes,
  requiredBytesForPages,
  type DatabaseUsage,
} from '../../domain/storage.ts';
import { measureDatabaseFiles, otherBudgetedBytes } from './database-files.ts';

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
  if (history.length !== userVersion || history.some((row, index) => row.version !== index + 1)) {
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

export interface MigrationStoragePlan {
  readonly configuredLimitBytes: number;
  readonly currentUsageBytes: number;
  readonly databaseBytes: number;
  readonly journalBoundBytes: number;
  readonly newBackupBytes: number;
  readonly existingBackupBytes: number;
  /** Room kept for control and maintenance transactions after the migration. */
  readonly reserveBytes: number;
  readonly estimatedRequiredTotalBytes: number;
  readonly requiredAdditionalBytes: number;
  /** max_page_count for the main database while migrating. */
  readonly maxPageCount: number;
}

/**
 * Worst-case storage for applying migrations, using the same capacity model as every other
 * transaction (domain/storage.ts databaseCapacity) with the new backup added to the fixed
 * files. The migrated database must still leave the control/maintenance reserve free.
 */
export function planMigrationStorage(input: {
  readonly usage: DatabaseUsage;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freelistCount: number;
  readonly btreeCount: number;
  readonly headroomBytes: number;
  readonly needsBackup: boolean;
  readonly budgetBytes: number;
}): MigrationStoragePlan {
  const { usage, pageSize } = input;
  const newBackupBytes = input.needsBackup ? (input.pageCount - input.freelistCount) * pageSize : 0;
  const fixedBytes = otherBudgetedBytes(usage) + newBackupBytes;
  const capacity = databaseCapacity({
    budgetBytes: input.budgetBytes,
    fixedBytes,
    pageSize,
    btreeCount: input.btreeCount,
  });
  const reservePages = capacity.maxPages - capacity.writeMaxPages;
  const neededPages = input.pageCount + Math.ceil(input.headroomBytes / pageSize);
  const estimatedRequiredTotalBytes = requiredBytesForPages({
    pages: neededPages,
    reservePages,
    pageSize,
    fixedBytes,
  });
  const currentUsageBytes = databaseUsedBytes(usage);
  return {
    configuredLimitBytes: input.budgetBytes,
    currentUsageBytes,
    databaseBytes: neededPages * pageSize,
    journalBoundBytes:
      JOURNAL_HEADER_BYTES + neededPages * (pageSize + JOURNAL_RECORD_OVERHEAD_BYTES),
    newBackupBytes,
    existingBackupBytes: usage.backupBytes,
    reserveBytes: reservePages * journalPerPageBytes(pageSize),
    estimatedRequiredTotalBytes,
    requiredAdditionalBytes: Math.max(0, estimatedRequiredTotalBytes - currentUsageBytes),
    maxPageCount: capacity.maxPages,
  };
}

/**
 * Tables and indexes in the schema; each is one b-tree. The storage reserve is sized from this,
 * so the migrator and the store must count the same way.
 */
export function countSchemaBtrees(db: DatabaseSync): number {
  const row = db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE rootpage > 0').get();
  return Number(row?.['n']);
}

/**
 * Runs inside the migration's transaction, before COMMIT. A migration can add tables and
 * indexes, and the control reserve grows with the number of b-trees, so the reserve is
 * re-checked against the schema SQLite actually has now, not against anything the migration
 * declares.
 */
function assertReserveAfterMigration(
  db: DatabaseSync,
  migration: Migration,
  context: {
    databasePath: string;
    backupDir: string;
    budgetBytes: number;
    backupPath: string | null;
  },
): void {
  const pageSize = pragmaNumber(db, 'page_size');
  const pageCount = pragmaNumber(db, 'page_count');
  const btreeCount = countSchemaBtrees(db);
  const usage = measureDatabaseFiles(context.databasePath, context.backupDir);
  // The journal belongs to this transaction and is truncated at commit.
  const fixedBytes = otherBudgetedBytes(usage, { includeJournal: false });
  const capacity = databaseCapacity({
    budgetBytes: context.budgetBytes,
    fixedBytes,
    pageSize,
    btreeCount,
  });
  if (pageCount <= capacity.writeMaxPages) return;
  const reservePages = capacity.maxPages - capacity.writeMaxPages;
  const estimatedRequiredTotalBytes = requiredBytesForPages({
    pages: pageCount,
    reservePages,
    pageSize,
    fixedBytes,
  });
  throw new OrviaError(
    'MIGRATION_STORAGE_REQUIRED',
    `migration v${migration.version} (${migration.name}) leaves no room for the control reserve ` +
      `(${pageCount} pages, ${btreeCount} tables and indexes; writes stop at ` +
      `${capacity.writeMaxPages} pages) and was rolled back. Raise storage.database_max_mb.`,
    {
      version: migration.version,
      name: migration.name,
      configuredLimitBytes: context.budgetBytes,
      postMigrationPageCount: pageCount,
      postMigrationBtreeCount: btreeCount,
      writeMaxPages: capacity.writeMaxPages,
      maxPages: capacity.maxPages,
      estimatedRequiredTotalBytes,
      requiredAdditionalBytes: Math.max(0, estimatedRequiredTotalBytes - context.budgetBytes),
      backupPath: context.backupPath,
      configKey: 'storage.database_max_mb',
    },
  );
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
 * rollback-journal mode, the connection's normal mode, whose journal size is bounded by the
 * database size.
 */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
  options: { backupDir: string; now: () => Date; budgetBytes: number },
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
    btreeCount: countSchemaBtrees(db),
    headroomBytes: pending.reduce((sum, migration) => sum + (migration.headroomBytes ?? 0), 0),
    needsBackup: fromVersion > 0,
    budgetBytes: options.budgetBytes,
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
      assertReserveAfterMigration(db, migration, {
        databasePath,
        backupDir: options.backupDir,
        budgetBytes: options.budgetBytes,
        backupPath,
      });
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (isOrviaError(error)) throw error;
      if (errcode(error) === SQLITE_FULL) {
        throw storageError(
          `migration v${migration.version} (${migration.name}) grew beyond the database budget ` +
            'and was rolled back; raise storage.database_max_mb',
          plan,
          { version: migration.version, name: migration.name, backupPath },
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
