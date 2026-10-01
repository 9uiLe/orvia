import { DatabaseSync } from 'node:sqlite';
import { OrviaError, isOrviaError } from '../../domain/errors.ts';
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
  readonly pageSize: number;
  /** Bytes the WAL may reach before the automatic checkpoint resets it. */
  readonly walCheckpointBytes: number;
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
 * Opens the database as its sole owner.
 *
 * `locking_mode = EXCLUSIVE` makes SQLite hold its file lock for the life of the connection,
 * so any other process (a second daemon, the sqlite3 CLI, an agent) gets SQLITE_BUSY. The lock
 * is an OS file lock and is released if the daemon crashes. This deliberately gives up
 * multi-process readers: the daemon is the only reader and writer.
 */
export function openDatabase(options: OpenDatabaseOptions): OpenedDatabase {
  validateMigrationList(options.migrations);
  const db = new DatabaseSync(options.path, { timeout: 0, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    const header = readHeader(db);
    assertCompatible(header, latestVersion(options.migrations));
    if (header.pageCount === 0) initializeFreshDatabase(db);
    const pageSize = Number(pragmaValue(db, 'page_size'));
    const walCheckpointBytes = Number(pragmaValue(db, 'wal_autocheckpoint')) * pageSize;
    const migration = applyMigrations(db, options.migrations, {
      backupDir: options.backupDir,
      now: options.now,
      budget: { databaseMaxBytes: options.databaseMaxBytes, reserveBytes: walCheckpointBytes },
    });
    if (pragmaValue(db, 'journal_mode = WAL') !== 'wal') {
      throw new OrviaError('INTERNAL', 'could not enable WAL journal mode');
    }
    // Truncate the WAL back to one checkpoint interval after each checkpoint.
    db.exec(`PRAGMA journal_size_limit = ${walCheckpointBytes}`);
    return { db, migration, pageSize, walCheckpointBytes };
  } catch (error) {
    db.close();
    throw translateSqliteError(error);
  }
}

/**
 * The last fuse during normal operation: SQLite refuses to grow the main database file beyond
 * this many bytes. Migrations use their own, tighter cap (see applyMigrations).
 */
export function setDatabaseHardCap(opened: OpenedDatabase, maxBytes: number): void {
  const pages = Math.max(1, Math.floor(maxBytes / opened.pageSize));
  opened.db.exec(`PRAGMA max_page_count = ${pages}`);
}
