import {
  assessStorage,
  needsCleanup,
  type StorageAssessment,
  type StorageLimits,
  type StorageUsage,
} from '../domain/storage.ts';
import type { Dependencies } from './dependencies.ts';
import type { RunId } from '../domain/ids.ts';
import type { CleanupFailure } from './ports.ts';

/**
 * Every cache entry of one run, derived from its log ref: the log, raw stdout result and result
 * schema. Cleanup protects and removes them together until report recording finishes.
 */
export function runCacheRefs(outputRef: string): {
  log: string;
  result: string;
  schema: string;
} {
  const base = outputRef.replace(/\.log$/, '');
  return { log: outputRef, result: `${base}.result`, schema: `${base}.schema.json` };
}

function allRunCacheRefs(outputRef: string): string[] {
  return Object.values(runCacheRefs(outputRef));
}

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
  readonly vacuumedPages: number;
  readonly failures: CleanupFailure[];
}

/**
 * Bounded-storage maintenance. It only touches Orvia's own database rows, cache entries,
 * and migration backups; it has no access to git or to any repository path.
 */
export class StorageService {
  readonly #deps: Dependencies;
  readonly #recordingRunIds: () => readonly RunId[];
  #running: Promise<CleanupReport> | null = null;

  constructor(deps: Dependencies, recordingRunIds: () => readonly RunId[]) {
    this.#deps = deps;
    this.#recordingRunIds = recordingRunIds;
  }

  async status(): Promise<StorageStatus> {
    const usage: StorageUsage = {
      database: await this.#deps.databaseFiles.measure(),
      cacheBytes: await this.#deps.cache.measureBytes(),
    };
    const { maintenance } = this.#deps.store;
    return {
      usage,
      assessment: assessStorage(
        usage,
        this.#deps.limits,
        maintenance.shape(),
        maintenance.capacity(),
      ),
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

    // One run per transaction, matching the shared control-reserve budget.
    const pruned = { runIds: [] as string[], outputRefs: [] as string[] };
    const candidates = attempt(
      'database:runs',
      () => store.runs.listFinishedBeyond(limits.maxCompletedRunsPerWorkItem),
      [],
    );
    const recordingRunIds = new Set(this.#recordingRunIds());
    for (const candidate of candidates) {
      if (recordingRunIds.has(candidate.runId)) continue;
      const deleted = attempt(
        `database:run:${candidate.runId}`,
        () => {
          store.transaction(() => {
            store.runs.delete(candidate.runId);
          }, 'reserve');
          return true;
        },
        false,
      );
      if (!deleted) break;
      pruned.runIds.push(candidate.runId);
      if (candidate.outputRef !== null)
        pruned.outputRefs.push(...allRunCacheRefs(candidate.outputRef));
    }
    failures.push(...(await cache.remove(pruned.outputRefs)));

    const expiresBefore = new Date(clock.now().getTime() - limits.retentionDays * DAY_MS);
    const protectedRefs = new Set(
      attempt(
        'database:pending',
        () => [
          ...store.runs.listRunning(),
          ...this.#recordingRunIds().flatMap((id) => {
            const run = store.runs.get(id);
            return run === null ? [] : [run];
          }),
        ],
        [],
      ).flatMap((run) => (run.outputRef === null ? [] : allRunCacheRefs(run.outputRef))),
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
      vacuumedPages: vacuum.freedPages,
      failures,
    };
  }
}
