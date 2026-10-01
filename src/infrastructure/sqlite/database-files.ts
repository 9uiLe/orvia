import { readdirSync, statSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CleanupFailure, DatabaseFiles } from '../../application/ports.ts';
import type { DatabaseUsage } from '../../domain/storage.ts';

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every file that counts toward `storage.database_max_mb`: the database, its WAL, SHM, and
 * rollback journal (used while migrating), and everything in the backup directory, including
 * partial backups.
 */
export function measureDatabaseFiles(databasePath: string, backupDir: string): DatabaseUsage {
  return {
    mainBytes: sizeOf(databasePath),
    walBytes: sizeOf(`${databasePath}-wal`),
    shmBytes: sizeOf(`${databasePath}-shm`),
    journalBytes: sizeOf(`${databasePath}-journal`),
    backupBytes: listFiles(backupDir).reduce((sum, path) => sum + sizeOf(path), 0),
  };
}

export class SqliteDatabaseFiles implements DatabaseFiles {
  readonly #databasePath: string;
  readonly #backupDir: string;

  constructor(databasePath: string, backupDir: string) {
    this.#databasePath = databasePath;
    this.#backupDir = backupDir;
  }

  measure(): Promise<DatabaseUsage> {
    return Promise.resolve(measureDatabaseFiles(this.#databasePath, this.#backupDir));
  }

  async pruneBackups(olderThan: Date): Promise<{ removed: string[]; failures: CleanupFailure[] }> {
    const removed: string[] = [];
    const failures: CleanupFailure[] = [];
    let names: string[];
    try {
      names = await readdir(this.#backupDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed, failures };
      throw error;
    }
    for (const path of names.map((name) => join(this.#backupDir, name))) {
      try {
        if ((await stat(path)).mtime < olderThan) {
          await rm(path, { force: true });
          removed.push(path);
        }
      } catch (error) {
        failures.push({ target: path, message: (error as Error).message });
      }
    }
    return { removed, failures };
  }
}
