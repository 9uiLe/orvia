// Measures the latency of the status queries a human triggers from chat ("what is happening
// now?"). It reports numbers only; there is no pass/fail threshold (see README "Performance").
//
//   npm run bench -- [--plans N] [--work-items-per-plan N] [--iterations N]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { invokeOperation } from '../src/application/operations.ts';
import { parseConfig } from '../src/infrastructure/config.ts';
import { createLogger } from '../src/infrastructure/logger.ts';
import { resolvePaths } from '../src/infrastructure/paths.ts';
import { startDaemon } from '../src/interface/daemon/daemon.ts';
import { IpcClient } from '../src/interface/ipc-client.ts';

const { values } = parseArgs({
  options: {
    plans: { type: 'string', default: '100' },
    'work-items-per-plan': { type: 'string', default: '5' },
    iterations: { type: 'string', default: '500' },
  },
});
const plans = Number(values.plans);
const perPlan = Number(values['work-items-per-plan']);
const iterations = Number(values.iterations);

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
  config: parseConfig('', 'bench'),
  logger: createLogger('error'),
});
try {
  const app = daemon.app;
  for (let p = 1; p <= plans; p++) {
    await invokeOperation(app, 'create_plan', { title: `Plan ${p}`, description: 'benchmark' });
    await invokeOperation(app, 'record_decision', { planId: `P-${p}`, title: 'd', body: 'b' });
    await invokeOperation(app, 'add_context', { planId: `P-${p}`, body: 'context' });
    for (let w = 0; w < perPlan; w++) {
      await invokeOperation(app, 'create_work_item', { planId: `P-${p}`, title: `W ${w}` });
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
      `${plans} plans × ${perPlan} work items, ${iterations} iterations`,
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
