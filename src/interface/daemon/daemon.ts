import type { Server } from 'node:http';
import { Application } from '../../application/application.ts';
import type { AgentAdapter, Clock, Logger, ProcessLauncher } from '../../application/ports.ts';
import { claudeAdapter, codexAdapter } from '../../infrastructure/agents/adapters.ts';
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
import { SqliteDatabaseFiles } from '../../infrastructure/sqlite/database-files.ts';
import { openDatabase, setDatabaseHardCap } from '../../infrastructure/sqlite/database.ts';
import type { Migration, MigrationReport } from '../../infrastructure/sqlite/migrator.ts';
import { MIGRATIONS } from '../../infrastructure/sqlite/migrations/index.ts';
import { SqliteStore } from '../../infrastructure/sqlite/sqlite-store.ts';
import { startIpcServer } from './ipc-server.ts';

export interface DaemonOptions {
  readonly paths: OrviaPaths;
  readonly config?: OrviaConfig;
  readonly migrations?: readonly Migration[];
  readonly agents?: readonly AgentAdapter[];
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
  const store = new SqliteStore(opened.db, options.migrations ?? MIGRATIONS);
  let server: Server | null = null;
  try {
    const limits = storageLimits(config, opened.walCheckpointBytes);
    setDatabaseHardCap(opened, limits.databaseMaxBytes);
    const agents = options.agents ?? [
      codexAdapter(config.agents.codex?.command),
      claudeAdapter(config.agents.claude?.command),
    ];
    const app = new Application({
      store,
      databaseFiles: new SqliteDatabaseFiles(paths.databaseFile, paths.backupDir),
      cache: new FileCache(paths.cacheDir, limits.cacheMaxBytes),
      git: new GitWorkspaceInspector(new GitCli()),
      agents: new Map(agents.map((adapter) => [adapter.name, adapter])),
      launcher:
        options.launcher ??
        new NodeProcessLauncher({
          graceMs: config.agents.termination_grace_ms,
          killConfirmationMs: config.agents.kill_confirmation_ms,
        }),
      clock,
      logger,
      limits,
    });
    if (opened.migration.applied.length > 0) {
      logger.info('database migrated', {
        from: opened.migration.fromVersion,
        to: opened.migration.toVersion,
      });
    }
    const interrupted = app.runs.recover();
    if (interrupted.length > 0) {
      logger.warn('runs from a previous daemon were marked interrupted', {
        count: interrupted.length,
      });
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
