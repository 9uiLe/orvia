import {
  assessStorage,
  needsCleanup,
  type StorageAssessment,
  type StorageLimits,
  type StorageUsage,
} from '../domain/storage.ts';
import type { Dependencies } from './dependencies.ts';
import type { CheckpointResult, CleanupFailure } from './ports.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StorageStatus {
  readonly usage: StorageUsage;
  readonly assessment: StorageAssessment;
  readonly limits: StorageLimits;
}

export interface CleanupReport {
  readonly before: StorageAssessment;
  readonly after: StorageAssessment;
  readonly prunedRunIds: string[];
  readonly cacheEntriesRemoved: number;
  readonly cacheBytesFreed: number;
  readonly backupsRemoved: string[];
  readonly checkpoint: CheckpointResult | null;
  readonly vacuumedPages: number;
  readonly failures: CleanupFailure[];
}

/**
 * Bounded-storage maintenance. It only touches Orvia's own database rows, cache entries,
 * and migration backups; it has no access to git or to any repository path.
 */
export class StorageService {
  readonly #deps: Dependencies;
  #running: Promise<CleanupReport> | null = null;

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  async status(): Promise<StorageStatus> {
    const usage: StorageUsage = {
      database: await this.#deps.databaseFiles.measure(),
      cacheBytes: await this.#deps.cache.measureBytes(),
    };
    return {
      usage,
      assessment: assessStorage(usage, this.#deps.limits),
      limits: this.#deps.limits,
    };
  }

  async assess(): Promise<StorageAssessment> {
    return (await this.status()).assessment;
  }

  /** Concurrent callers share one cleanup pass. */
  cleanup(): Promise<CleanupReport> {
    this.#running ??= this.#cleanup().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async cleanupIfNeeded(): Promise<CleanupReport | null> {
    const assessment = await this.assess();
    if (!needsCleanup(assessment)) return null;
    this.#deps.logger.info('storage above normal; starting cleanup', { level: assessment.level });
    return this.cleanup();
  }

  async #cleanup(): Promise<CleanupReport> {
    const { store, cache, databaseFiles, limits, clock, logger } = this.#deps;
    const before = await this.assess();
    const failures: CleanupFailure[] = [];
    const attempt = <T>(target: string, fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch (error) {
        failures.push({ target, message: error instanceof Error ? error.message : String(error) });
        return fallback;
      }
    };

    const pruned = attempt(
      'database:runs',
      () => store.transaction(() => store.runs.pruneFinished(limits.maxCompletedRunsPerWorkItem)),
      { runIds: [], outputRefs: [] },
    );
    failures.push(...(await cache.remove(pruned.outputRefs)));

    const expiresBefore = new Date(clock.now().getTime() - limits.retentionDays * DAY_MS);
    const protectedRefs = new Set(
      attempt('database:running', () => store.runs.listRunning(), []).flatMap((run) =>
        run.outputRef === null ? [] : [run.outputRef],
      ),
    );
    const sweep = await cache.sweep({
      expiresBefore,
      // Evict until the cache is back under the PRESSURE threshold, not merely under the limit.
      targetBytes: Math.max(
        0,
        Math.ceil((limits.cacheMaxBytes * limits.pressurePercent) / 100) - 1,
      ),
      protectedRefs,
    });
    failures.push(...sweep.failures);

    const backups = await databaseFiles.pruneBackups(expiresBefore);
    failures.push(...backups.failures);

    const checkpoint = attempt('database:checkpoint', () => store.maintenance.checkpoint(), null);
    const vacuum = attempt('database:vacuum', () => store.maintenance.incrementalVacuum(), {
      freedPages: 0,
    });

    const after = await this.assess();
    for (const failure of failures) {
      logger.warn('storage cleanup step failed', { target: failure.target });
    }
    logger.info('storage cleanup finished', {
      before: before.level,
      after: after.level,
      failures: failures.length,
    });
    return {
      before,
      after,
      prunedRunIds: pruned.runIds,
      cacheEntriesRemoved: sweep.removed,
      cacheBytesFreed: sweep.freedBytes,
      backupsRemoved: backups.removed,
      checkpoint,
      vacuumedPages: vacuum.freedPages,
      failures,
    };
  }
}
