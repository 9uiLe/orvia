import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { makeTestEnv, writeConfig, type TestEnv } from '../helpers/env.ts';
import { createRepository } from '../helpers/git.ts';

const CLI = fileURLToPath(new URL('../../src/interface/cli/main.ts', import.meta.url));

describe('orvia CLI', () => {
  let env: TestEnv;
  let daemon: ChildProcess | null;

  beforeEach(() => {
    env = makeTestEnv();
    daemon = null;
  });
  afterEach(async () => {
    if (daemon !== null && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise((resolve) => daemon?.once('exit', resolve));
      daemon.kill('SIGTERM');
      await exited;
    }
    env.cleanup();
  });

  function orvia(...args: string[]) {
    return spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env.env },
    });
  }

  async function startDaemonProcess(): Promise<void> {
    daemon = spawn(process.execPath, [CLI, 'daemon'], {
      env: { ...process.env, ...env.env },
      stdio: 'ignore',
    });
    for (let i = 0; i < 300; i++) {
      if (orvia('status').status === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('daemon did not start');
  }

  test('commands fail clearly when the daemon is not running', () => {
    const result = orvia('status');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DAEMON_NOT_RUNNING/);
  });

  test('doctor works without a daemon and does not create a database', () => {
    const result = orvia('doctor', '--json');
    assert.equal(result.status, 0, result.stderr);
    const checks = JSON.parse(result.stdout) as { name: string; status: string }[];
    assert.equal(checks.find((check) => check.name === 'daemon')?.status, 'warn');
    assert.equal(checks.find((check) => check.name === 'config')?.status, 'ok');
    assert.throws(() => readdirSync(env.paths.dataDir), { code: 'ENOENT' });
  });

  test('doctor reports an invalid configuration', () => {
    writeConfig(env, JSON.stringify({ storage: { cache_max_mb: -1 } }));
    const result = orvia('doctor', '--json');
    assert.equal(result.status, 1);
    const checks = JSON.parse(result.stdout) as { name: string; status: string }[];
    assert.equal(checks.find((check) => check.name === 'config')?.status, 'fail');
  });

  test('operations map to flags and print JSON', async () => {
    await startDaemonProcess();
    const created = orvia('create-plan', '--title', 'KMP rollout');
    assert.equal(created.status, 0, created.stderr);
    assert.equal((JSON.parse(created.stdout) as { id: string }).id, 'P-1');

    const repo = createRepository(join(env.root, 'repo'));
    assert.equal(orvia('create-work-item', '--plan-id', 'P-1', '--title', 'W').status, 0);
    const bound = orvia('bind-workspace', '--work-item-id', 'W-1', '--worktree-path', repo);
    assert.equal(bound.status, 0, bound.stderr);

    const list = orvia('work-items', '--statuses', 'active', '--statuses', 'paused');
    assert.equal((JSON.parse(list.stdout) as unknown[]).length, 1);

    assert.equal(orvia('create-plan', '--nope', 'x').status, 2);
  });
});
