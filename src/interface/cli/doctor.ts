import { execFile } from 'node:child_process';
import { loadConfig } from '../../infrastructure/config.ts';
import { GitCli } from '../../infrastructure/git/git-cli.ts';
import type { OrviaPaths } from '../../infrastructure/paths.ts';
import { ORVIA_VERSION } from '../../version.ts';
import type { IpcClient } from '../ipc-client.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

const MINIMUM_NODE = [24, 15] as const;

function commandOutput(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      resolve(error === null ? (stdout.trim().split('\n')[0] ?? '') : null);
    });
  });
}

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const supported =
    major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
  return {
    name: 'node',
    status: supported ? 'ok' : 'fail',
    detail: `${process.versions.node} (requires >= ${MINIMUM_NODE.join('.')})`,
  };
}

/** Diagnoses the environment without opening the database; database checks go via the daemon. */
export async function runDoctor(paths: OrviaPaths, client: IpcClient): Promise<Check[]> {
  const checks: Check[] = [{ name: 'orvia', status: 'info', detail: ORVIA_VERSION }, nodeCheck()];

  const git = await new GitCli().version();
  checks.push({ name: 'git', status: git === null ? 'fail' : 'ok', detail: git ?? 'not found' });

  const nix = await commandOutput('nix', ['--version']);
  const inShell = process.env['IN_NIX_SHELL'] !== undefined;
  checks.push({
    name: 'nix',
    status: 'info',
    detail:
      (nix ?? 'not found (only needed to develop Orvia)') +
      (inShell ? '; inside a nix develop shell' : ''),
  });

  const sqlite = await commandOutput('sqlite3', ['--version']);
  checks.push({
    name: 'sqlite3 cli',
    status: 'info',
    detail: sqlite ?? 'not found (optional; Orvia uses the SQLite built into Node.js)',
  });

  try {
    loadConfig(paths.configFile);
    checks.push({ name: 'config', status: 'ok', detail: paths.configFile });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', detail: (error as Error).message });
  }
  checks.push({
    name: 'paths',
    status: 'info',
    detail: `data=${paths.dataDir} cache=${paths.cacheDir} socket=${paths.socketPath}`,
  });

  try {
    const health = await client.health();
    checks.push({
      name: 'daemon',
      status: 'ok',
      detail: `running (pid ${health.pid}, version ${health.version})`,
    });
    const schema = (await client.call('get_schema_status', {})) as {
      databaseVersion: number;
      supportedVersion: number;
    };
    checks.push({
      name: 'database schema',
      status: schema.databaseVersion === schema.supportedVersion ? 'ok' : 'warn',
      detail: `v${schema.databaseVersion} (this build supports v${schema.supportedVersion})`,
    });
    const storage = (await client.call('get_storage_status', {})) as {
      assessment: { level: string };
    };
    checks.push({
      name: 'storage',
      status: storage.assessment.level === 'NORMAL' ? 'ok' : 'warn',
      detail: storage.assessment.level,
    });
  } catch (error) {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `${(error as Error).message}; database and storage checks skipped`,
    });
  }
  return checks;
}
