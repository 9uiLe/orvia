import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CleanupFailure, DatabaseFiles } from '../../application/ports.ts';
import type { DatabaseUsage } from '../../domain/storage.ts';

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).map((name) => join(dir, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Measures every file that belongs to the database budget, including WAL, SHM, and backups. */
export class SqliteDatabaseFiles implements DatabaseFiles {
  readonly #databasePath: string;
  readonly #backupDir: string;

  constructor(databasePath: string, backupDir: string) {
    this.#databasePath = databasePath;
    this.#backupDir = backupDir;
  }

  async measure(): Promise<DatabaseUsage> {
    const backups = await listFiles(this.#backupDir);
    const backupSizes = await Promise.all(backups.map(sizeOf));
    return {
      mainBytes: await sizeOf(this.#databasePath),
      walBytes: await sizeOf(`${this.#databasePath}-wal`),
      shmBytes: await sizeOf(`${this.#databasePath}-shm`),
      backupBytes: backupSizes.reduce((sum, size) => sum + size, 0),
    };
  }

  async pruneBackups(olderThan: Date): Promise<{ removed: string[]; failures: CleanupFailure[] }> {
    const removed: string[] = [];
    const failures: CleanupFailure[] = [];
    for (const path of await listFiles(this.#backupDir)) {
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
