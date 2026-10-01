import { DatabaseSync } from 'node:sqlite';
import { OrviaError, isOrviaError } from '../../domain/errors.ts';
import { databaseUsedBytes } from '../../domain/storage.ts';
import { measureDatabaseFiles } from './database-files.ts';
import {
  applyMigrations,
  assertCompatible,
  initializeFreshDatabase,
  latestVersion,
  readHeader,
  validateMigrationList,
  type Migration,
  type MigrationReport,
} from './migrator.ts';

export interface OpenDatabaseOptions {
  readonly path: string;
  readonly backupDir: string;
  readonly migrations: readonly Migration[];
  readonly now: () => Date;
  /** `storage.database_max_mb` in bytes. */
  readonly databaseMaxBytes: number;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  readonly migration: MigrationReport;
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_FULL = 13;

function primaryCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('errcode' in error)) return null;
  const code = error.errcode;
  return typeof code === 'number' ? code & 0xff : null;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === 2067
  );
}

export function translateSqliteError(error: unknown): unknown {
  if (isOrviaError(error)) return error;
  const code = primaryCode(error);
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) {
    return new OrviaError(
      'DATABASE_LOCKED',
      'the Orvia database is owned by another process (is another orvia daemon running?)',
    );
  }
  if (code === SQLITE_FULL) {
    return new OrviaError(
      'STORAGE_HARD_LIMIT',
      'database size limit reached; run storage cleanup or raise storage.database_max_mb',
      { blockedBy: ['database'] },
    );
  }
  return error;
}

function pragmaValue(db: DatabaseSync, pragma: string): unknown {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

/**
 * Connection settings that make every database-related file bounded:
 * - rollback journal (DELETE): a transaction's journal holds each original page at most once,
 *   unlike WAL, whose growth within a transaction no pragma can cap;
 * - journal_size_limit = 0: in exclusive locking mode the journal is not deleted after commit,
 *   so it is truncated to zero bytes instead;
 * - cache_spill = OFF: the journal is synced only at commit, so it has a single header; dirty
 *   pages stay in memory until then, bounded by the page cap;
 * - temp_store = MEMORY: sorting, transient indices, and temporary tables never create files
 *   in the OS temporary directory (tested in test/integration/storage-contract.test.ts).
 */
function configureConnection(db: DatabaseSync): void {
  db.exec('PRAGMA journal_size_limit = 0');
  db.exec('PRAGMA cache_spill = OFF');
  db.exec('PRAGMA temp_store = MEMORY');
}

/**
 * A database left in WAL mode (by an earlier Orvia build, or a crash of one) is converted to
 * rollback-journal mode, which folds the WAL into the main file while both still exist. Each
 * WAL frame carries one page, so the main file can grow by at most the WAL's size: the peak is
 * at most main + 2 × WAL + the other files. This is checked before SQLite opens the file,
 * because closing a WAL connection checkpoints it, which would itself change the files.
 */
function assertWalTransitionFits(options: OpenDatabaseOptions): void {
  const usage = measureDatabaseFiles(options.path, options.backupDir);
  if (usage.walBytes === 0) return;
  const peakBytes = databaseUsedBytes(usage) + usage.walBytes;
  if (peakBytes <= options.databaseMaxBytes) return;
  throw new OrviaError(
    'STORAGE_HARD_LIMIT',
    `the database was left in WAL mode; converting it needs up to ${peakBytes} bytes but ` +
      `storage.database_max_mb allows ${options.databaseMaxBytes}. Raise it; nothing was changed.`,
    {
      blockedBy: ['database'],
      blockedOperation: 'leave WAL mode',
      configuredLimitBytes: options.databaseMaxBytes,
      currentUsageBytes: databaseUsedBytes(usage),
      estimatedRequiredTotalBytes: peakBytes,
      requiredAdditionalBytes: peakBytes - databaseUsedBytes(usage),
      configKey: 'storage.database_max_mb',
    },
  );
}

/**
 * Opens the database as its sole owner.
 *
 * `locking_mode = EXCLUSIVE` makes SQLite hold its file lock for the life of the connection,
 * so any other process (a second daemon, the sqlite3 CLI, an agent) gets SQLITE_BUSY. The lock
 * is an OS file lock and is released if the daemon crashes. This deliberately gives up
 * multi-process readers: the daemon is the only reader and writer.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  validateMigrationList(options.migrations);
  assertWalTransitionFits(options);
  const db = new DatabaseSync(options.path, { timeout: 0, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // The first read rolls back a hot journal left by a crash; that restores original pages and
    // truncates the file to its original size, so it never grows storage.
    const header = readHeader(db);
    assertCompatible(header, latestVersion(options.migrations));
    configureConnection(db);
    if (header.pageCount === 0) initializeFreshDatabase(db);
    if (pragmaValue(db, 'journal_mode = DELETE') !== 'delete') {
      throw new OrviaError('INTERNAL', 'could not select rollback-journal mode');
    }
    const migration = applyMigrations(db, options.migrations, {
      backupDir: options.backupDir,
      now: options.now,
      budgetBytes: options.databaseMaxBytes,
    });
    return { db, migration };
  } catch (error) {
    db.close();
    throw translateSqliteError(error);
  }
}
