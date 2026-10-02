import { execFile } from 'node:child_process';
import type { AgentProfileView } from '../../application/agent-profiles.ts';
import type { SchemaStatus } from '../../application/ports.ts';
import type { RecoveryView } from '../../application/status.ts';
import type { StorageStatus } from '../../application/storage.ts';
import {
  IMPLEMENTATION_PROFILE_STAGES,
  REVIEW_PROFILE_STAGES,
} from '../../domain/agent-profile.ts';
import type { StageState } from '../../domain/cycle.ts';
import { loadConfig } from '../../infrastructure/config.ts';
import { GitCli } from '../../infrastructure/git/git-cli.ts';
import type { OrviaPaths } from '../../infrastructure/paths.ts';
import { MINIMUM_NODE_VERSION, ORVIA_VERSION } from '../../version.ts';
import type { IpcClient } from '../ipc-client.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

function commandOutput(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      resolve(error === null ? (stdout.trim().split('\n')[0] ?? '') : null);
    });
  });
}

function nodeCheck(): Check {
  const current = process.versions.node.split('.').map(Number);
  let supported = true;
  for (const [index, minimum] of MINIMUM_NODE_VERSION.entries()) {
    const actual = current[index] ?? 0;
    if (actual !== minimum) {
      supported = actual > minimum;
      break;
    }
  }
  return {
    name: 'node',
    status: supported ? 'ok' : 'fail',
    detail: `${process.versions.node} (requires >= ${MINIMUM_NODE_VERSION.join('.')})`,
  };
}

interface ProfileListing {
  readonly profiles: readonly AgentProfileView[];
  readonly defaults: {
    readonly implementationProfileId: string | null;
    readonly reviewProfileId: string | null;
  };
}

function profileChecks(listing: ProfileListing): Check[] {
  const checks: Check[] = listing.profiles.map((profile) => ({
    name: `agent profile ${profile.id}`,
    status: profile.available ? 'ok' : 'warn',
    detail:
      `adapter ${profile.adapter}; command ${profile.command}` +
      (profile.available ? '' : ' NOT FOUND') +
      `; capabilities: ${profile.capabilities.join(', ') || 'none'}` +
      `; stages: ${profile.stages.join(', ') || 'none'}`,
  }));
  const defaults: [string, string | null, readonly StageState[]][] = [
    [
      'default implementation profile',
      listing.defaults.implementationProfileId,
      IMPLEMENTATION_PROFILE_STAGES,
    ],
    ['default review profile', listing.defaults.reviewProfileId, REVIEW_PROFILE_STAGES],
  ];
  for (const [name, id, stages] of defaults) {
    if (id === null) {
      checks.push({ name, status: 'info', detail: 'not set; start_cycle must name a profile' });
      continue;
    }
    const profile = listing.profiles.find((candidate) => candidate.id === id);
    const missing = stages.filter((stage) => !profile?.stages.includes(stage));
    checks.push({
      name,
      status: profile?.available === true && missing.length === 0 ? 'ok' : 'warn',
      detail:
        id +
        (profile?.available === true ? '' : '; command not found') +
        (missing.length === 0 ? '' : `; cannot run ${missing.join(', ')}`),
    });
  }
  return checks;
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
    const schema = (await client.call('get_schema_status', {})) as SchemaStatus;
    checks.push({
      name: 'database schema',
      status: schema.databaseVersion === schema.supportedVersion ? 'ok' : 'warn',
      detail: `v${schema.databaseVersion} (this build supports v${schema.supportedVersion})`,
    });
    const status = (await client.call('get_status', {})) as { recovery: RecoveryView };
    checks.push({
      name: 'recovery',
      status: status.recovery.state === 'complete' ? 'ok' : 'warn',
      detail:
        status.recovery.state === 'complete'
          ? 'complete'
          : `incomplete: ${String(status.recovery.remainingRuns)} run(s) still marked running. ${status.recovery.remediation}`,
    });
    const storage = (await client.call('get_storage_status', {})) as StorageStatus;
    checks.push({
      name: 'storage',
      status: storage.assessment.level === 'NORMAL' ? 'ok' : 'warn',
      detail: storage.assessment.level,
    });
    // The daemon's view: its configuration and PATH are what agent runs use.
    checks.push(...profileChecks((await client.call('list_agent_profiles', {})) as ProfileListing));
  } catch (error) {
    checks.push({
      name: 'daemon',
      status: 'warn',
      detail: `${(error as Error).message}; database, storage, and agent profile checks skipped`,
    });
  }
  return checks;
}
