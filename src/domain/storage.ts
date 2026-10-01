import { OrviaError } from './errors.ts';

export const PRESSURE_LEVELS = ['NORMAL', 'PRESSURE', 'WARNING', 'HARD_LIMIT'] as const;
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

export interface StorageLimits {
  readonly databaseMaxBytes: number;
  readonly cacheMaxBytes: number;
  /** Headroom kept below the database limit so checkpoint and cleanup can still run. */
  readonly databaseReserveBytes: number;
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
  readonly hardLimitBytes: number;
  readonly level: PressureLevel;
}

export interface StorageAssessment {
  readonly database: AreaAssessment;
  readonly cache: AreaAssessment;
  readonly level: PressureLevel;
}

/**
 * - `read`: never blocked.
 * - `control`: pause/resume and other human safety controls; never blocked.
 * - `maintenance`: cleanup (which frees space) and archive (a small status change that frees
 *   almost none); never blocked, so work can be wound down and space reclaimed at the limit.
 * - `write`: durable writes; blocked when the database is at HARD_LIMIT.
 * - `agent_run`: starts output-producing work; blocked when either area is at HARD_LIMIT.
 */
export type OperationClass = 'read' | 'control' | 'maintenance' | 'write' | 'agent_run';

export function databaseUsedBytes(usage: DatabaseUsage): number {
  return usage.mainBytes + usage.walBytes + usage.shmBytes + usage.journalBytes + usage.backupBytes;
}

function assessArea(
  usedBytes: number,
  limitBytes: number,
  reserveBytes: number,
  limits: StorageLimits,
): AreaAssessment {
  const hardLimitBytes = limitBytes - reserveBytes;
  let level: PressureLevel = 'NORMAL';
  if (usedBytes >= hardLimitBytes) level = 'HARD_LIMIT';
  else if (usedBytes * 100 >= limitBytes * limits.warningPercent) level = 'WARNING';
  else if (usedBytes * 100 >= limitBytes * limits.pressurePercent) level = 'PRESSURE';
  return { usedBytes, limitBytes, hardLimitBytes, level };
}

function maxLevel(a: PressureLevel, b: PressureLevel): PressureLevel {
  return PRESSURE_LEVELS.indexOf(a) >= PRESSURE_LEVELS.indexOf(b) ? a : b;
}

export function assessStorage(usage: StorageUsage, limits: StorageLimits): StorageAssessment {
  const database = assessArea(
    databaseUsedBytes(usage.database),
    limits.databaseMaxBytes,
    limits.databaseReserveBytes,
    limits,
  );
  // Cache relief is deletion only, so it needs no headroom of its own.
  const cache = assessArea(usage.cacheBytes, limits.cacheMaxBytes, 0, limits);
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
      `storage hard limit reached (${blockedBy.join(', ')}); run storage cleanup or raise the limits`,
      { blockedBy, operationClass },
    );
  }
}
