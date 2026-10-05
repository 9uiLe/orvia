import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CleanupFailure,
  EphemeralStore,
  OutputWriter,
  WriterOptions,
} from '../../application/ports.ts';
import { OrviaError } from '../../domain/errors.ts';

interface Entry {
  readonly ref: string;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

interface ActiveWriter {
  /** Bytes counted against the budget: what was written, or the reservation if larger. */
  counted: number;
}

/**
 * Ephemeral storage under the cache directory. Writers share one byte budget derived from the
 * configured cache limit, so concurrent agent runs cannot push the cache past it together.
 *
 * Usage is the closed files measured on disk plus what open writers have counted. An open
 * writer's file is never measured: its size on disk lags behind the bytes it accepted, and
 * measuring it would let a later write reuse budget those bytes already took.
 */
export class FileCache implements EphemeralStore {
  readonly #root: string;
  readonly #maxBytes: number;
  /** Closed files as last measured; null until the first measurement. */
  #closedBytes: number | null = null;
  readonly #writers = new Map<string, ActiveWriter>();
  /** For each measurement in progress: writers that closed meanwhile, with their final size. */
  readonly #measurements = new Set<Map<string, number>>();

  constructor(root: string, maxBytes: number) {
    this.#root = resolve(root);
    this.#maxBytes = maxBytes;
  }

  #openBytes(): number {
    let total = 0;
    for (const writer of this.#writers.values()) total += writer.counted;
    return total;
  }

  /** Unknown until the first measurement; dropping output is safer than overrunning the cap. */
  #available(): number {
    if (this.#closedBytes === null) return 0;
    return Math.max(0, this.#maxBytes - this.#closedBytes - this.#openBytes());
  }

  async measureBytes(): Promise<number> {
    const closedMeanwhile = new Map<string, number>();
    this.#measurements.add(closedMeanwhile);
    let entries: Entry[];
    try {
      entries = await this.#entries();
    } finally {
      this.#measurements.delete(closedMeanwhile);
    }
    let closed = 0;
    for (const entry of entries) {
      if (this.#writers.has(entry.path) || closedMeanwhile.has(entry.path)) continue;
      closed += entry.size;
    }
    // A writer that closed during the walk may have been measured before its last bytes were
    // flushed, or skipped as open; its final size is known exactly.
    for (const bytes of closedMeanwhile.values()) closed += bytes;
    this.#closedBytes = closed;
    return closed + this.#openBytes();
  }

  createWriter(ref: string, options: WriterOptions = {}): OutputWriter {
    const path = this.#resolve(ref);
    const reserved = options.reserveBytes ?? 0;
    if (reserved > this.#available()) {
      throw new OrviaError(
        'RESULT_STORAGE_EXHAUSTED',
        `the cache cannot set aside ${reserved} bytes for ${ref}`,
        { ref, reserveBytes: reserved, availableBytes: this.#available() },
      );
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stream: WriteStream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    const active: ActiveWriter = { counted: reserved };
    this.#writers.set(path, active);
    let bytes = 0;
    let truncated = false;
    let streamError: Error | null = null;
    stream.on('error', (error) => {
      streamError = error;
    });
    return {
      write: (chunk) => {
        if (truncated || streamError !== null) return;
        // A reserved writer stays within its reservation; others take from the shared budget.
        const room = reserved > 0 ? reserved - bytes : this.#available() + active.counted - bytes;
        const allowed = Math.max(0, Math.min(chunk.byteLength, room));
        if (allowed < chunk.byteLength) truncated = true;
        if (allowed === 0) return;
        bytes += allowed;
        active.counted = Math.max(reserved, bytes);
        stream.write(chunk.subarray(0, allowed));
      },
      close: () =>
        new Promise((resolveClose) => {
          stream.end((error?: Error | null) => {
            streamError ??= error ?? null;
            this.#writers.delete(path);
            if (this.#closedBytes !== null) this.#closedBytes += bytes;
            for (const closedMeanwhile of this.#measurements) closedMeanwhile.set(path, bytes);
            resolveClose({ bytes, truncated, failed: streamError !== null });
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

  async readHead(ref: string, maxBytes: number): Promise<string | null> {
    let handle;
    try {
      handle = await open(this.#resolve(ref), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }

  absolutePath(ref: string): string {
    return this.#resolve(ref);
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
    await this.measureBytes();
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
      if (options.protectedRefs.has(entry.ref) || this.#writers.has(entry.path)) continue;
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
    await this.measureBytes();
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
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          // A concurrent cleanup may remove an entry between readdir and lstat.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
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
