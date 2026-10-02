import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrviaError } from '../../src/domain/errors.ts';
import { FileCache } from '../../src/infrastructure/cache/file-cache.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';

const KIB = 1024;

function diskBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    try {
      const info = statSync(join(dir, name));
      if (info.isFile()) total += info.size;
    } catch {
      // Removed by a concurrent sweep.
    }
  }
  return total;
}

describe('cache budget', () => {
  let env: TestEnv;
  let dir: string;

  beforeEach(() => {
    env = makeTestEnv();
    dir = join(env.root, 'cache');
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    env.cleanup();
  });

  test('concurrent writers, measurements, and cleanup never exceed the cap', async () => {
    const max = 64 * KIB;
    const cache = new FileCache(dir, max);
    await cache.measureBytes();
    const chunk = new Uint8Array(KIB).fill(120);
    let peak = 0;
    let running = true;

    const slowWriter = async (ref: string, chunks: number) => {
      const writer = cache.createWriter(ref);
      for (let i = 0; i < chunks; i++) {
        writer.write(chunk);
        await sleep(1);
      }
      return writer.close();
    };
    const observer = async () => {
      while (running) {
        await cache.measureBytes();
        await cache.sweep({
          expiresBefore: new Date(0),
          targetBytes: Math.floor(max * 0.7),
          protectedRefs: new Set(),
        });
        peak = Math.max(peak, diskBytes(dir));
        await sleep(1);
      }
    };

    const watching = observer();
    const [a, b] = await Promise.all([
      slowWriter('runs/a.log', 120),
      slowWriter('runs/b.log', 120),
      (async () => {
        await sleep(20);
        // A writer that finishes early; the sweep may then free its space for the others.
        await slowWriter('runs/c.log', 8);
      })(),
    ]);
    running = false;
    await watching;
    peak = Math.max(peak, diskBytes(dir));

    assert.ok(peak <= max, `peak ${peak} bytes exceeds the ${max}-byte cap`);
    assert.equal(a.truncated && b.truncated, true, 'the writers ran into the cap');
    assert.ok((await cache.measureBytes()) <= max);
  });

  test('a measurement does not hand out bytes an open writer already took', async () => {
    const max = 32 * KIB;
    const cache = new FileCache(dir, max);
    await cache.measureBytes();
    const first = cache.createWriter('runs/first.log');
    first.write(new Uint8Array(max).fill(1));
    await cache.measureBytes();
    const second = cache.createWriter('runs/second.log');
    second.write(new Uint8Array(KIB).fill(2));
    assert.deepEqual(await second.close(), { bytes: 0, truncated: true, failed: false });
    assert.equal((await first.close()).bytes, max);
    assert.equal(diskBytes(dir), max);
  });

  test('space freed by cleanup can be written again', async () => {
    const max = 16 * KIB;
    const cache = new FileCache(dir, max);
    await cache.measureBytes();
    const full = cache.createWriter('runs/old.log');
    full.write(new Uint8Array(max));
    await full.close();
    await cache.sweep({ expiresBefore: new Date(0), targetBytes: 0, protectedRefs: new Set() });
    const next = cache.createWriter('runs/new.log');
    next.write(new Uint8Array(KIB));
    assert.equal((await next.close()).bytes, KIB);
  });

  test('reserved space is kept for its writer and refused when it is not available', async () => {
    const max = 16 * KIB;
    const cache = new FileCache(dir, max);
    await cache.measureBytes();
    const reserved = cache.createWriter('runs/x.result', { reserveBytes: 10 * KIB });
    const log = cache.createWriter('runs/x.log');
    log.write(new Uint8Array(max));
    assert.equal((await log.close()).bytes, 6 * KIB, 'the log cannot use the reservation');
    reserved.write(new Uint8Array(4 * KIB));
    reserved.write(new Uint8Array(7 * KIB));
    assert.deepEqual(await reserved.close(), { bytes: 10 * KIB, truncated: true, failed: false });
    assert.throws(
      () => cache.createWriter('runs/y.result', { reserveBytes: 1 }),
      (error: unknown) => error instanceof OrviaError && error.code === 'RESULT_STORAGE_EXHAUSTED',
    );
  });

  test('entries removed while the cache is being measured are skipped', async () => {
    const cache = new FileCache(dir, 1024 * KIB);
    for (let round = 0; round < 20; round++) {
      const sub = join(dir, `round-${String(round)}`);
      mkdirSync(sub);
      for (let i = 0; i < 200; i++) writeFileSync(join(sub, `f${String(i)}`), 'x');
      await Promise.all([cache.measureBytes(), rm(sub, { recursive: true, force: true })]);
    }
    rmSync(dir, { recursive: true, force: true });
    assert.equal(await cache.measureBytes(), 0);
  });
});
