import { OrviaError } from './errors.ts';

export const PRESSURE_LEVELS = ['NORMAL', 'PRESSURE', 'WARNING', 'HARD_LIMIT'] as const;
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

export interface StorageLimits {
  /** Hard budget for every database-related file: main file, journal, and backups. */
  readonly databaseMaxBytes: number;
  readonly cacheMaxBytes: number;
  readonly pressurePercent: number;
  readonly warningPercent: number;
  readonly retentionDays: number;
  readonly maxCompletedRunsPerWorkItem: number;
}

export interface DatabaseUsage {
  readonly mainBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly journalBytes: number;
  readonly backupBytes: number;
}

export interface StorageUsage {
  readonly database: DatabaseUsage;
  readonly cacheBytes: number;
}

export interface AreaAssessment {
  readonly usedBytes: number;
  readonly limitBytes: number;
  readonly level: PressureLevel;
}

export interface DatabaseAssessment extends AreaAssessment {
  /** Logical size of the main database (page count × page size). */
  readonly dataBytes: number;
  /** Data size at which ordinary writes are refused (HARD_LIMIT). */
  readonly writeCapacityBytes: number;
  /** Data size no transaction may exceed; the room above writeCapacityBytes is for control and maintenance. */
  readonly maxCapacityBytes: number;
}

export interface StorageAssessment {
  readonly database: DatabaseAssessment;
  readonly cache: AreaAssessment;
  readonly level: PressureLevel;
}

/**
 * An upper bound for one rollback-journal header. The SQLite documentation says the header is
 * padded to the sector size; the 64 KiB ceiling is SQLite's MAX_SECTOR_SIZE in pager.c. With
 * cache spilling disabled the journal is synced once, at commit, so it has a single header.
 * test/integration/storage-contract.test.ts measures a full-rewrite journal against this bound.
 */
export const JOURNAL_HEADER_BYTES = 65_536;
/** Per journaled page: a 4-byte page number and a 4-byte checksum around the page content. */
export const JOURNAL_RECORD_OVERHEAD_BYTES = 8;

export interface DatabaseShape {
  readonly pageSize: number;
  readonly pageCount: number;
  /** Tables and indexes in the schema; each is one b-tree. */
  readonly btreeCount: number;
}

export interface DatabaseCapacity {
  /** No transaction may grow the main database beyond this many pages. */
  readonly maxPages: number;
  /** Ordinary writes may not grow it beyond this many pages. */
  readonly writeMaxPages: number;
}

/** Worst-case bytes one page adds to the budget: the page itself plus its journal record. */
export function journalPerPageBytes(pageSize: number): number {
  return 2 * pageSize + JOURNAL_RECORD_OVERHEAD_BYTES;
}

/** Budget needed to hold `pages` pages plus the control reserve, with a full journal and the fixed files. */
export function requiredBytesForPages(input: {
  readonly pages: number;
  readonly reservePages: number;
  readonly pageSize: number;
  readonly fixedBytes: number;
}): number {
  return (
    (input.pages + input.reservePages) * journalPerPageBytes(input.pageSize) +
    JOURNAL_HEADER_BYTES +
    input.fixedBytes
  );
}

/**
 * Page caps that keep main file + rollback journal + everything else within the budget.
 *
 * A transaction's journal holds each page that existed when it began at most once, so with the
 * main file capped at `maxPages` the journal is at most `maxPages` records plus one header.
 * `fixedBytes` is every other file in the budget (backups, WAL, SHM, and any journal left on disk).
 *
 * Control and maintenance transactions (pause, recording a run's result, cleanup) may use the
 * pages between `writeMaxPages` and `maxPages`. They change one row per b-tree, and one row
 * change splits at most one page per level of each b-tree it touches, plus one new root. A
 * b-tree's depth is at most log2(pages), since every interior page has at least two children.
 * One pointer-map page is added for auto_vacuum.
 */
export function databaseCapacity(input: {
  readonly budgetBytes: number;
  readonly fixedBytes: number;
  readonly pageSize: number;
  readonly btreeCount: number;
}): DatabaseCapacity {
  const perPage = journalPerPageBytes(input.pageSize);
  const available = input.budgetBytes - input.fixedBytes - JOURNAL_HEADER_BYTES;
  const maxPages = Math.max(0, Math.floor(available / perPage));
  const depth = Math.ceil(Math.log2(Math.max(maxPages, 2)));
  const reservePages = input.btreeCount * (depth + 1) + 1;
  return { maxPages, writeMaxPages: Math.max(0, maxPages - reservePages) };
}

/**
 * Admission at HARD_LIMIT (the pre-operation gate; SQLite may still refuse a reserve
 * transaction once the shared reserve is used up):
 * - `read`: never refused.
 * - `control`: pause/resume and other human safety controls; not refused by the gate.
 * - `maintenance`: cleanup (which frees space) and archive (a small status change that frees
 *   almost none); not refused by the gate, so work can be wound down and space reclaimed.
 * - `write`: durable writes; blocked when the database is at HARD_LIMIT.
 * - `agent_run`: starts output-producing work; blocked when either area is at HARD_LIMIT.
 */
export type OperationClass = 'read' | 'control' | 'maintenance' | 'write' | 'agent_run';

export function databaseUsedBytes(usage: DatabaseUsage): number {
  return usage.mainBytes + usage.walBytes + usage.shmBytes + usage.journalBytes + usage.backupBytes;
}

function levelFor(used: number, hardLimit: number, limits: StorageLimits): PressureLevel {
  if (used >= hardLimit) return 'HARD_LIMIT';
  if (used * 100 >= hardLimit * limits.warningPercent) return 'WARNING';
  if (used * 100 >= hardLimit * limits.pressurePercent) return 'PRESSURE';
  return 'NORMAL';
}

function maxLevel(a: PressureLevel, b: PressureLevel): PressureLevel {
  return PRESSURE_LEVELS.indexOf(a) >= PRESSURE_LEVELS.indexOf(b) ? a : b;
}

/**
 * Database pressure is measured on the data: the journal is transient and backups are what
 * shrink the capacity, so the level reflects how much more data fits.
 */
export function assessStorage(
  usage: StorageUsage,
  limits: StorageLimits,
  shape: DatabaseShape,
  capacity: DatabaseCapacity,
): StorageAssessment {
  const dataBytes = shape.pageCount * shape.pageSize;
  const writeCapacityBytes = capacity.writeMaxPages * shape.pageSize;
  const database: DatabaseAssessment = {
    usedBytes: databaseUsedBytes(usage.database),
    limitBytes: limits.databaseMaxBytes,
    dataBytes,
    writeCapacityBytes,
    maxCapacityBytes: capacity.maxPages * shape.pageSize,
    level: levelFor(dataBytes, writeCapacityBytes, limits),
  };
  // Cache relief is deletion only, so it needs no headroom of its own.
  const cache: AreaAssessment = {
    usedBytes: usage.cacheBytes,
    limitBytes: limits.cacheMaxBytes,
    level: levelFor(usage.cacheBytes, limits.cacheMaxBytes, limits),
  };
  return { database, cache, level: maxLevel(database.level, cache.level) };
}

export function needsCleanup(assessment: StorageAssessment): boolean {
  return assessment.level !== 'NORMAL';
}

export function assertOperationAllowed(
  assessment: StorageAssessment,
  operationClass: OperationClass,
): void {
  const blockedBy: string[] = [];
  if (operationClass === 'write' || operationClass === 'agent_run') {
    if (assessment.database.level === 'HARD_LIMIT') blockedBy.push('database');
  }
  if (operationClass === 'agent_run' && assessment.cache.level === 'HARD_LIMIT') {
    blockedBy.push('cache');
  }
  if (blockedBy.length > 0) {
    throw new OrviaError(
      'STORAGE_HARD_LIMIT',
      `storage hard limit reached (${blockedBy.join(', ')}); run storage cleanup or raise ` +
        'storage.database_max_mb / storage.cache_max_mb',
      {
        blockedBy,
        operationClass,
        database: assessment.database,
        cache: assessment.cache,
      },
    );
  }
}
