import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startStorageSampler } from '../../scripts/storage-sampler.ts';
import { makeTestEnv } from '../helpers/env.ts';

test('a ready sampler can stop immediately, return all measurements, and stop repeatedly', async () => {
  const env = makeTestEnv();
  const databaseFile = join(env.root, 'state.db');
  writeFileSync(databaseFile, Buffer.alloc(100));
  writeFileSync(`${databaseFile}-journal`, Buffer.alloc(20));
  let sampler: Awaited<ReturnType<typeof startStorageSampler>> | null = null;
  try {
    sampler = await startStorageSampler(databaseFile);
    const peak = await sampler.stop();
    assert.equal(peak['main'], 100);
    assert.equal(peak['journal'], 20);
    assert.equal(peak['total'], 120);
    assert.ok((peak['samples'] ?? 0) > 0);
    assert.deepEqual(await sampler.stop(), peak);
  } finally {
    await sampler?.stop();
    env.cleanup();
  }
});

test('the storage benchmark measures a single seeded Plan and Work Item for one iteration', async () => {
  const script = fileURLToPath(new URL('../../scripts/bench-storage.ts', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [
    script,
    '--plans',
    '1',
    '--work-items-per-plan',
    '1',
    '--iterations',
    '1',
  ]);
  assert.match(stdout, /1 plans × 1 work items seeded, 1 iterations/);
  assert.match(stdout, /mixed\s+8 ops/);
  assert.match(stdout, /peak bytes\s+\{.*"samples":\d+/);
  assert.doesNotMatch(stdout, /NaN|Infinity/);
});
