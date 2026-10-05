// Measures the latency of the status queries a human triggers from chat ("what is happening
// now?"). It reports numbers only; there is no pass/fail threshold
// (see docs/current-implementation.md "Performance").
//
//   npm run bench -- [--plans N] [--work-items-per-plan N] [--iterations N]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeOperation } from '../src/application/operations.ts';
import { validateConfig } from '../src/infrastructure/config.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import { resolvePaths } from '../src/infrastructure/paths.ts';
import { startDaemon } from '../src/interface/daemon/daemon.ts';
import { IpcClient } from '../src/interface/ipc-client.ts';
import { benchmarkOptions } from './benchmark-options.ts';

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

async function measure(fn: () => Promise<unknown>): Promise<string> {
  for (let i = 0; i < Math.min(50, iterations); i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const f = (n: number) => n.toFixed(3).padStart(8);
  return `p50 ${f(percentile(samples, 50))} ms  p95 ${f(percentile(samples, 95))} ms  max ${f(samples.at(-1) ?? NaN)} ms`;
}

const daemon = await startDaemon({
  paths,
  config: validateConfig({}, 'bench'),
  logger: createLogger('error'),
});
try {
  const app = daemon.app;
  for (let p = 1; p <= plans; p++) {
    await invokeOperation(app, 'create_plan', { title: `Plan ${p}`, description: 'benchmark' });
    await invokeOperation(app, 'record_decision', { planId: `P-${p}`, title: 'd', body: 'b' });
    await invokeOperation(app, 'add_context', { planId: `P-${p}`, body: 'context' });
    for (let w = 0; w < perPlan; w++) {
      const item = (await invokeOperation(app, 'create_work_item', {
        planId: `P-${p}`,
        title: `W ${w}`,
      })) as { id: `W-${number}` };
      // Every Work Item has the most cycles get_status can show for it: one active.
      app.deps.store.transaction(() =>
        app.deps.store.cycles.insert({
          workItemId: item.id,
          mode: 'implement',
          state: 'IMPLEMENTING',
          maxAutoFixRounds: 3,
          implementationProfileId: 'primary',
          reviewProfileId: 'reviewer',
          instructions: 'benchmark',
          baseCommit: '0000000000000000000000000000000000000000',
          now: new Date().toISOString(),
        }),
      );
    }
  }
  const client = new IpcClient(paths.socketPath);
  const middle = `P-${Math.ceil(plans / 2)}`;
  const cases: [string, string, Record<string, unknown>][] = [
    ['get_status', 'get_status', {}],
    ['get_plan', 'get_plan', { planId: middle }],
    ['list_work_items', 'list_work_items', {}],
    ['get_storage_status', 'get_storage_status', {}],
  ];

  console.log(
    `Orvia benchmark — node ${process.versions.node}, ${process.platform}/${process.arch}, ` +
      `${plans} plans × ${perPlan} work items (one active cycle each), ${iterations} iterations`,
  );
  for (const [label, operation, input] of cases) {
    console.log(
      `${label.padEnd(20)} in-process  ${await measure(() => invokeOperation(app, operation, input))}`,
    );
    console.log(
      `${''.padEnd(20)} via socket  ${await measure(() => client.call(operation, input))}`,
    );
  }
} finally {
  await daemon.close();
  rmSync(root, { recursive: true, force: true });
}
