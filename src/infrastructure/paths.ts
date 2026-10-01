import { lstatSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { OrviaError } from '../domain/errors.ts';

/** Where Orvia keeps its own state. Never inside a user's repository. */
export interface OrviaPaths {
  readonly configDir: string;
  readonly configFile: string;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly backupDir: string;
  readonly cacheDir: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
}

interface PlatformInfo {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly tmp: string;
  readonly user: string;
  readonly uid: number;
}

function currentPlatform(): PlatformInfo {
  const info = userInfo();
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    tmp: tmpdir(),
    user: info.username,
    uid: info.uid,
  };
}

function defaults(p: PlatformInfo): {
  config: string;
  data: string;
  cache: string;
  runtime: string;
} {
  const { env, home } = p;
  if (p.platform === 'darwin') {
    return {
      config: join(home, 'Library', 'Application Support', 'orvia'),
      data: join(home, 'Library', 'Application Support', 'orvia'),
      cache: join(home, 'Library', 'Caches', 'orvia'),
      runtime: join(p.tmp, `orvia-${p.uid}`),
    };
  }
  if (p.platform === 'win32') {
    const roaming = env['APPDATA'] ?? join(home, 'AppData', 'Roaming');
    const local = env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    return {
      config: join(roaming, 'orvia'),
      data: join(local, 'orvia', 'data'),
      cache: join(local, 'orvia', 'cache'),
      runtime: join(local, 'orvia', 'run'),
    };
  }
  return {
    config: join(env['XDG_CONFIG_HOME'] ?? join(home, '.config'), 'orvia'),
    data: join(env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'), 'orvia'),
    cache: join(env['XDG_CACHE_HOME'] ?? join(home, '.cache'), 'orvia'),
    runtime:
      env['XDG_RUNTIME_DIR'] === undefined
        ? join(p.tmp, `orvia-${p.uid}`)
        : join(env['XDG_RUNTIME_DIR'], 'orvia'),
  };
}

export function resolvePaths(platform: PlatformInfo = currentPlatform()): OrviaPaths {
  const base = defaults(platform);
  const env = platform.env;
  const configDir = env['ORVIA_CONFIG_DIR'] ?? base.config;
  const dataDir = env['ORVIA_DATA_DIR'] ?? base.data;
  const runtimeDir = env['ORVIA_RUNTIME_DIR'] ?? base.runtime;
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    dataDir,
    databaseFile: join(dataDir, 'state.db'),
    backupDir: join(dataDir, 'backups'),
    cacheDir: env['ORVIA_CACHE_DIR'] ?? base.cache,
    runtimeDir,
    socketPath:
      platform.platform === 'win32'
        ? `\\\\.\\pipe\\orvia-${platform.user}`
        : join(runtimeDir, 'orvia.sock'),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * For the runtime directory, which may live in a shared temp dir: the socket inside it is only
 * protected by this directory's ownership and mode, so an existing directory is verified too.
 */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new OrviaError(
      'CONFIG_INVALID',
      `${path} must be a directory owned by the current user with mode 0700`,
      { path },
    );
  }
}
