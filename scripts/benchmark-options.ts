import { parseArgs } from 'node:util';

export function benchmarkOptions(args: readonly string[] = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      plans: { type: 'string', default: '100' },
      'work-items-per-plan': { type: 'string', default: '5' },
      iterations: { type: 'string', default: '500' },
    },
  });
  const count = (name: keyof typeof values): number => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`--${name} must be a positive safe integer`);
    }
    return value;
  };
  return {
    plans: count('plans'),
    perPlan: count('work-items-per-plan'),
    iterations: count('iterations'),
  };
}
