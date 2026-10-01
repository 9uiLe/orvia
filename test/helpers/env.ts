import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, Logger } from '../../src/application/ports.ts';
import { parseConfig, type OrviaConfig } from '../../src/infrastructure/config.ts';
import { resolvePaths, type OrviaPaths } from '../../src/infrastructure/paths.ts';

export interface TestEnv {
  readonly root: string;
  readonly paths: OrviaPaths;
  readonly env: Record<string, string>;
  cleanup(): void;
}

/** Isolated Orvia directories. The socket lives under a short path to stay within sun_path limits. */
export function makeTestEnv(): TestEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orvia-')));
  const env = {
    ORVIA_CONFIG_DIR: join(root, 'config'),
    ORVIA_DATA_DIR: join(root, 'data'),
    ORVIA_CACHE_DIR: join(root, 'cache'),
    ORVIA_RUNTIME_DIR: join(root, 'run'),
  };
  const paths = resolvePaths({
    platform: process.platform,
    env,
    home: root,
    tmp: root,
    user: 'test',
    uid: process.getuid?.() ?? 0,
  });
  return {
    root,
    paths,
    env,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeConfig(env: TestEnv, toml: string): void {
  mkdirSync(env.paths.configDir, { recursive: true });
  writeFileSync(env.paths.configFile, toml);
}

export function config(toml = ''): OrviaConfig {
  return parseConfig(toml, 'test');
}

export const silentLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export class ManualClock implements Clock {
  #now: Date;

  constructor(start = new Date('2026-01-01T00:00:00Z')) {
    this.#now = start;
  }

  now(): Date {
    return new Date(this.#now);
  }

  advanceDays(days: number): void {
    this.#now = new Date(this.#now.getTime() + days * 24 * 60 * 60 * 1000);
  }
}
