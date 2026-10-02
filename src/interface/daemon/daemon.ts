import type { Server } from 'node:http';
import { Application } from '../../application/application.ts';
import { isOrviaError } from '../../domain/errors.ts';
import type { AgentAdapter, Clock, Logger, ProcessLauncher } from '../../application/ports.ts';
import { buildAgentProfiles } from '../../application/agent-profiles.ts';
import { BUNDLED_ADAPTERS } from '../../infrastructure/agents/adapters.ts';
import { NodeProcessLauncher } from '../../infrastructure/agents/process-launcher.ts';
import { FileCache } from '../../infrastructure/cache/file-cache.ts';
import {
  databaseBudgetBytes,
  loadConfig,
  storageLimits,
  type OrviaConfig,
} from '../../infrastructure/config.ts';
import { GitCli } from '../../infrastructure/git/git-cli.ts';
import { GitWorkspaceInspector } from '../../infrastructure/git/workspace-inspector.ts';
import { createLogger } from '../../infrastructure/logger.ts';
import { ensureDir, ensurePrivateDir, type OrviaPaths } from '../../infrastructure/paths.ts';
import {
  measureDatabaseFiles,
  otherBudgetedBytes,
  SqliteDatabaseFiles,
} from '../../infrastructure/sqlite/database-files.ts';
import { openDatabase } from '../../infrastructure/sqlite/database.ts';
import type { Migration, MigrationReport } from '../../infrastructure/sqlite/migrator.ts';
import { MIGRATIONS } from '../../infrastructure/sqlite/migrations/index.ts';
import { SqliteStore } from '../../infrastructure/sqlite/sqlite-store.ts';
import { startIpcServer } from './ipc-server.ts';

export interface DaemonOptions {
  readonly paths: OrviaPaths;
  readonly config?: OrviaConfig;
  readonly migrations?: readonly Migration[];
  /** Adapters that profiles can use; the bundled ones by default. */
  readonly adapters?: readonly AgentAdapter[];
  readonly launcher?: ProcessLauncher;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Tests that drive the Application directly can skip the socket. */
  readonly listen?: boolean;
}

export interface Daemon {
  readonly app: Application;
  readonly migration: MigrationReport;
  readonly store: SqliteStore;
  close(): Promise<void>;
}

/**
 * The composition root and the only code path that opens the database.
 * Order matters: the database lock and the schema check happen before the socket accepts
 * requests, so an incompatible or already-owned database stops startup before any client
 * can reach it.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { paths } = options;
  const config = options.config ?? loadConfig(paths.configFile);
  const logger = options.logger ?? createLogger(config.log_level);
  const clock: Clock = options.clock ?? { now: () => new Date() };
  for (const dir of [paths.dataDir, paths.backupDir, paths.cacheDir]) ensureDir(dir);
  ensurePrivateDir(paths.runtimeDir);

  const opened = openDatabase({
    path: paths.databaseFile,
    backupDir: paths.backupDir,
    migrations: options.migrations ?? MIGRATIONS,
    now: () => clock.now(),
    databaseMaxBytes: databaseBudgetBytes(config),
  });
  const store = new SqliteStore(opened.db, options.migrations ?? MIGRATIONS, {
    budgetBytes: databaseBudgetBytes(config),
    fixedBytes: () => otherBudgetedBytes(measureDatabaseFiles(paths.databaseFile, paths.backupDir)),
  });
  let server: Server | null = null;
  try {
    const limits = storageLimits(config);
    const profiles = buildAgentProfiles(
      config.agents.profiles,
      options.adapters ?? BUNDLED_ADAPTERS,
    );
    const app = new Application({
      store,
      databaseFiles: new SqliteDatabaseFiles(paths.databaseFile, paths.backupDir),
      cache: new FileCache(paths.cacheDir, limits.cacheMaxBytes),
      git: new GitWorkspaceInspector(new GitCli()),
      profiles,
      launcher:
        options.launcher ??
        new NodeProcessLauncher({
          graceMs: config.agents.termination_grace_ms,
          killConfirmationMs: config.agents.kill_confirmation_ms,
        }),
      clock,
      logger,
      limits,
      orchestration: {
        maxAutoFixRounds: config.orchestration.max_review_fix_cycles,
        defaultImplementationProfile: config.orchestration.default_implementation_profile ?? null,
        defaultReviewProfile: config.orchestration.default_review_profile ?? null,
        maxReviewDiffBytes: config.orchestration.max_review_diff_kb * 1024,
      },
    });
    if (opened.migration.applied.length > 0) {
      logger.info('database migrated', {
        from: opened.migration.fromVersion,
        to: opened.migration.toVersion,
      });
    }
    const recovery = app.runs.recover();
    if (recovery.recoveredRunIds.length > 0) {
      logger.warn('runs from a previous daemon were marked interrupted', {
        count: recovery.recoveredRunIds.length,
      });
    }
    if (recovery.state === 'incomplete') {
      // Degraded start: inspection, controls, and cleanup stay available; writes are refused
      // until a restart completes recovery (ADR 0009).
      logger.error('startup recovery incomplete: database storage reserve exhausted', {
        remaining: recovery.remainingRunIds.length,
      });
    }
    try {
      const blocked = app.cycles.blockInterrupted();
      if (blocked.length > 0) {
        logger.warn('cycles interrupted by the previous daemon were blocked', {
          count: blocked.length,
        });
      }
    } catch (error) {
      if (!isOrviaError(error) || error.code !== 'STORAGE_HARD_LIMIT') throw error;
      logger.error('could not block interrupted cycles: database storage reserve exhausted');
    }
    await app.storage.cleanupIfNeeded();
    if (options.listen !== false) server = await startIpcServer(app, paths.socketPath);
    logger.info('orvia daemon ready', { pid: process.pid, socket: paths.socketPath });

    const listening = server;
    return {
      app,
      store,
      migration: opened.migration,
      close: async () => {
        // Stop accepting requests, stop every agent process tree and record the runs, and
        // only then close the database.
        if (listening !== null) {
          await new Promise<void>((resolve) => {
            listening.close(() => {
              resolve();
            });
            listening.closeAllConnections();
          });
        }
        await app.runs.shutdown();
        store.close();
        logger.info('orvia daemon stopped');
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
