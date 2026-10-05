import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkOptions } from '../../scripts/benchmark-options.ts';

test('benchmark workload counts default to the documented values and permit one record', () => {
  assert.deepEqual(benchmarkOptions([]), { plans: 100, perPlan: 5, iterations: 500 });
  assert.deepEqual(
    benchmarkOptions(['--plans', '1', '--work-items-per-plan', '1', '--iterations', '1']),
    { plans: 1, perPlan: 1, iterations: 1 },
  );
});

test('every workload count rejects values that cannot describe a positive integer count', () => {
  for (const name of ['plans', 'work-items-per-plan', 'iterations']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
      assert.throws(() => benchmarkOptions([`--${name}=${value}`]), {
        message: `--${name} must be a positive safe integer`,
      });
    }
  }
});
