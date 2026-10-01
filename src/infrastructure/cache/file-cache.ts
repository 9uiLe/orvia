import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CleanupFailure, EphemeralStore, OutputWriter } from '../../application/ports.ts';
import { OrviaError } from '../../domain/errors.ts';

interface Entry {
  readonly ref: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Ephemeral storage under the cache directory. Writers share one byte budget derived from the
 * configured cache limit, so concurrent agent runs cannot push the cache past it together.
 */
export class FileCache implements EphemeralStore {
  readonly #root: string;
  readonly #maxBytes: number;
  #remainingBytes: number;

  constructor(root: string, maxBytes: number) {
    this.#root = resolve(root);
    this.#maxBytes = maxBytes;
    // Unknown until measureBytes(); dropping output is safer than overrunning the cap.
    this.#remainingBytes = 0;
  }

  async measureBytes(): Promise<number> {
    const total = (await this.#entries()).reduce((sum, entry) => sum + entry.size, 0);
    this.#remainingBytes = Math.max(0, this.#maxBytes - total);
    return total;
  }

  createWriter(ref: string): OutputWriter {
    const path = this.#resolve(ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stream: WriteStream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    let bytes = 0;
    let truncated = false;
    let streamError: Error | null = null;
    stream.on('error', (error) => {
      streamError = error;
    });
    return {
      write: (chunk) => {
        if (truncated || streamError !== null) return;
        const allowed = Math.min(chunk.byteLength, this.#remainingBytes);
        if (allowed < chunk.byteLength) truncated = true;
        if (allowed === 0) return;
        this.#remainingBytes -= allowed;
        bytes += allowed;
        stream.write(chunk.subarray(0, allowed));
      },
      close: () =>
        new Promise((resolveClose) => {
          stream.end(() => {
            resolveClose({ bytes, truncated: truncated || streamError !== null });
          });
        }),
    };
  }

  async readTail(ref: string, maxBytes: number): Promise<string | null> {
    let handle;
    try {
      handle = await open(this.#resolve(ref), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }

  async remove(refs: readonly string[]): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = [];
    for (const ref of refs) {
      try {
        await rm(this.#resolve(ref), { force: true });
      } catch (error) {
        failures.push({ target: `cache:${ref}`, message: (error as Error).message });
      }
    }
    return failures;
  }

  async sweep(options: {
    expiresBefore: Date;
    targetBytes: number;
    protectedRefs: ReadonlySet<string>;
  }): Promise<{ removed: number; freedBytes: number; failures: CleanupFailure[] }> {
    const entries = (await this.#entries()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let removed = 0;
    let freedBytes = 0;
    const failures: CleanupFailure[] = [];
    const expiry = options.expiresBefore.getTime();

    for (const entry of entries) {
      if (options.protectedRefs.has(entry.ref)) continue;
      const expired = entry.mtimeMs < expiry;
      if (!expired && total <= options.targetBytes) continue;
      try {
        await rm(entry.path, { force: true });
        total -= entry.size;
        freedBytes += entry.size;
        removed += 1;
      } catch (error) {
        failures.push({ target: `cache:${entry.ref}`, message: (error as Error).message });
      }
    }
    this.#remainingBytes = Math.max(0, this.#maxBytes - total);
    return { removed, freedBytes, failures };
  }

  #resolve(ref: string): string {
    const path = resolve(this.#root, ref);
    const rel = relative(this.#root, path);
    if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new OrviaError('INTERNAL', 'cache reference escapes the cache directory', { ref });
    }
    return path;
  }

  async #entries(): Promise<Entry[]> {
    const entries: Entry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) {
        const path = join(dir, name);
        const info = await lstat(path);
        if (info.isDirectory()) await walk(path);
        else
          entries.push({
            ref: relative(this.#root, path).split(sep).join('/'),
            path,
            size: info.size,
            mtimeMs: info.mtimeMs,
          });
      }
    };
    await walk(this.#root);
    return entries;
  }
}
