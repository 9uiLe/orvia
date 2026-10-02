import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { AGENT_CAPABILITIES, PROFILE_ID_PATTERN } from '../domain/agent-profile.ts';
import { OrviaError } from '../domain/errors.ts';
import type { StorageLimits } from '../domain/storage.ts';

const MIB = 1024 * 1024;
const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
const megabytes = z
  .int()
  .positive()
  .max(Math.floor(Number.MAX_SAFE_INTEGER / MIB));
const profile = z.strictObject({
  adapter: z.string().min(1),
  command: z.string().min(1).optional(),
  capabilities: z.array(z.enum(AGENT_CAPABILITIES)).optional(),
});
const profileId = z
  .string()
  .regex(PROFILE_ID_PATTERN, 'profile ids are lowercase letters, digits, and dashes');

// Defaults: storage sizes are the values proposed in the project brief, and the pressure
// thresholds and agent termination timeouts were chosen by the maintainer; see
// docs/adr/0004-storage-policy.md and docs/adr/0008-agent-process-lifecycle.md.
const configSchema = z
  .strictObject({
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
    agents: z
      .strictObject({
        termination_grace_ms: z.int().positive().default(10_000),
        kill_confirmation_ms: z.int().positive().default(5_000),
        // One profile per bundled adapter until the user defines their own.
        profiles: z
          .record(profileId, profile)
          .default({ codex: { adapter: 'codex' }, claude: { adapter: 'claude' } }),
      })
      .prefault({}),
    orchestration: z
      .strictObject({
        // The brief's first candidate (3); a human resume starts the count again (ADR 0010).
        max_review_fix_cycles: z.int().positive().default(3),
        default_implementation_profile: profileId.optional(),
        default_review_profile: profileId.optional(),
        // Chosen by the maintainer (ADR 0011): larger changes stop at NEEDS_HUMAN unreviewed.
        max_review_diff_kb: z.int().positive().default(256),
      })
      .prefault({}),
  })
  .superRefine((config, context) => {
    for (const key of ['default_implementation_profile', 'default_review_profile'] as const) {
      const id = config.orchestration[key];
      if (id !== undefined && !(id in config.agents.profiles)) {
        context.addIssue({
          code: 'custom',
          path: ['orchestration', key],
          message: `no agent profile named ${id}`,
        });
      }
    }
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

export function databaseBudgetBytes(config: OrviaConfig): number {
  return config.storage.database_max_mb * MIB;
}

export function storageLimits(config: OrviaConfig): StorageLimits {
  const s = config.storage;
  return {
    databaseMaxBytes: databaseBudgetBytes(config),
    cacheMaxBytes: s.cache_max_mb * MIB,
    pressurePercent: s.pressure_percent,
    warningPercent: s.warning_percent,
    retentionDays: s.retention_days,
    maxCompletedRunsPerWorkItem: s.max_completed_runs_per_work_item,
  };
}
