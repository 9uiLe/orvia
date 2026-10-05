// Measures Orvia's real operation mix and the size of every database-related file while it
// runs, so journal strategies can be compared on latency and on storage peaks. Reports numbers
// only; there is no pass/fail threshold.
//
//   npm run bench:storage -- [--plans N] [--work-items-per-plan N] [--iterations N]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeOperation } from '../src/application/operations.ts';
import { validateConfig } from '../src/infrastructure/config.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import { resolvePaths } from '../src/infrastructure/paths.ts';
import { startDaemon } from '../src/interface/daemon/daemon.ts';
import { benchmarkOptions } from './benchmark-options.ts';
import { startStorageSampler } from './storage-sampler.ts';

const { plans, perPlan, iterations } = benchmarkOptions();

const root = mkdtempSync(join(tmpdir(), 'orvia-bench-'));
const paths = resolvePaths({
  platform: process.platform,
  env: {
    ORVIA_CONFIG_DIR: join(root, 'config'),
    ORVIA_DATA_DIR: join(root, 'data'),
    ORVIA_CACHE_DIR: join(root, 'cache'),
    ORVIA_RUNTIME_DIR: join(root, 'run'),
  },
  home: root,
  tmp: root,
  user: 'bench',
  uid: process.getuid?.() ?? 0,
});

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;
}

const format = (n: number) => n.toFixed(3).padStart(8);
const body = 'The repository layer moves to KMP; keep the public API stable. '.repeat(3);

const daemon = await startDaemon({
  paths,
  config: validateConfig({}, 'bench'),
  logger: createLogger('error'),
  listen: false,
});
let sampler: Awaited<ReturnType<typeof startStorageSampler>> | null = null;
try {
  const app = daemon.app;
  const call = (operation: string, input: Record<string, unknown>) =>
    invokeOperation(app, operation, input);
  for (let p = 1; p <= plans; p++) {
    await call('create_plan', { title: `Plan ${p}`, description: body });
    for (let w = 0; w < perPlan; w++) {
      await call('create_work_item', { planId: `P-${p}`, title: `W ${w}` });
    }
  }

  let counter = 0;
  const operations: [string, () => Promise<unknown>][] = [
    ['create_plan', () => call('create_plan', { title: `Bench ${++counter}`, description: body })],
    [
      'create_work_item',
      () => call('create_work_item', { planId: 'P-1', title: `B ${++counter}` }),
    ],
    ['record_decision', () => call('record_decision', { planId: 'P-1', title: 'd', body })],
    ['add_context', () => call('add_context', { planId: 'P-2', body })],
    [
      'submit_feedback',
      () => call('submit_feedback', { workItemId: 'W-1', kind: 'comment', body }),
    ],
    ['update_work_item', () => call('update_work_item', { workItemId: 'W-2', description: body })],
    ['list_work_items', () => call('list_work_items', {})],
    ['get_status', () => call('get_status', {})],
  ];

  sampler = await startStorageSampler(paths.databaseFile);
  const samples = new Map<string, number[]>(operations.map(([name]) => [name, []]));
  const mixedStart = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    for (const [name, run] of operations) {
      const start = process.hrtime.bigint();
      await run();
      samples.get(name)?.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  }
  const mixedMs = Number(process.hrtime.bigint() - mixedStart) / 1e6;
  const peak = await sampler.stop();
  const finalUsage = await app.deps.databaseFiles.measure();

  console.log(
    `Orvia storage benchmark — node ${process.versions.node}, ${process.platform}/${process.arch}, ` +
      `${plans} plans × ${perPlan} work items seeded, ${iterations} iterations of the mix`,
  );
  for (const [name, list] of samples) {
    const sorted = [...list].sort((a, b) => a - b);
    console.log(
      `${name.padEnd(18)} p50 ${format(percentile(sorted, 50))} ms  p95 ${format(percentile(sorted, 95))} ms`,
    );
  }
  const totalOps = iterations * operations.length;
  console.log(
    `mixed              ${totalOps} ops in ${mixedMs.toFixed(0)} ms (${((totalOps / mixedMs) * 1000).toFixed(0)} ops/s)`,
  );
  console.log(`peak bytes         ${JSON.stringify(peak)}`);
  console.log(`final bytes        ${JSON.stringify(finalUsage)}`);
} finally {
  try {
    await sampler?.stop();
  } finally {
    try {
      await daemon.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
