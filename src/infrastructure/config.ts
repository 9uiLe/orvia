import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { OrviaError } from '../domain/errors.ts';
import type { StorageLimits } from '../domain/storage.ts';

const MIB = 1024 * 1024;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
const megabytes = z
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / MIB));
const agent = z.strictObject({ command: z.string().min(1) });

// Defaults: storage sizes are the values proposed in the project brief, and the pressure
// thresholds were chosen by the maintainer; see docs/adr/0004-storage-policy.md.
const configSchema = z.strictObject({
  log_level: z.enum(LOG_LEVELS).default('info'),
  storage: z
    .strictObject({
      database_max_mb: megabytes.default(128),
      cache_max_mb: megabytes.default(512),
      retention_days: z.int().positive().default(7),
      max_completed_runs_per_work_item: z.int().positive().default(5),
      pressure_percent: z.int().min(1).max(99).default(70),
      warning_percent: z.int().min(1).max(99).default(90),
    })
    .refine((storage) => storage.pressure_percent < storage.warning_percent, {
      message: 'pressure_percent must be lower than warning_percent',
    })
    .prefault({}),
  agents: z.strictObject({ codex: agent.optional(), claude: agent.optional() }).prefault({}),
});

export type OrviaConfig = z.output<typeof configSchema>;

export function validateConfig(raw: unknown, origin: string): OrviaConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new OrviaError('CONFIG_INVALID', `${origin}:\n${z.prettifyError(result.error)}`, {
      origin,
    });
  }
  return result.data;
}

export function parseConfig(source: string, origin: string): OrviaConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    throw new OrviaError('CONFIG_INVALID', `${origin}: ${(error as Error).message}`, { origin });
  }
  return validateConfig(raw, origin);
}

/** A missing file means "all defaults"; Orvia never writes the config file itself. */
export function loadConfig(path: string): OrviaConfig {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConfig({}, path);
    throw new OrviaError('CONFIG_INVALID', `cannot read ${path}: ${(error as Error).message}`);
  }
  return parseConfig(source, path);
}

export function storageLimits(config: OrviaConfig, databaseReserveBytes: number): StorageLimits {
  const s = config.storage;
  const databaseMaxBytes = s.database_max_mb * MIB;
  if (databaseMaxBytes <= databaseReserveBytes) {
    throw new OrviaError(
      'CONFIG_INVALID',
      `storage.database_max_mb must exceed the ${Math.ceil(databaseReserveBytes / MIB)} MiB maintenance reserve`,
      { databaseReserveBytes },
    );
  }
  return {
    databaseMaxBytes,
    cacheMaxBytes: s.cache_max_mb * MIB,
    databaseReserveBytes,
    pressurePercent: s.pressure_percent,
    warningPercent: s.warning_percent,
    retentionDays: s.retention_days,
    maxCompletedRunsPerWorkItem: s.max_completed_runs_per_work_item,
  };
}
