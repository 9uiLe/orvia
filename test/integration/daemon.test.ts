import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { IpcClient } from '../../src/interface/ipc-client.ts';
import { rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';

describe('daemon ownership and IPC', () => {
  let env: TestEnv;
  let daemon: Daemon | null;

  beforeEach(() => {
    env = makeTestEnv();
    daemon = null;
  });
  afterEach(async () => {
    await daemon?.close();
    env.cleanup();
  });

  test('clients reach the application only through the daemon socket', async () => {
    daemon = await startTestDaemon(env, { listen: true });
    const client = new IpcClient(env.paths.socketPath);
    const plan = (await client.call('create_plan', { title: 'over IPC' })) as { id: string };
    assert.equal(plan.id, 'P-1');
    const health = await client.health();
    assert.equal(health.pid, process.pid);
    const error = await rejectsWith(client.call('get_plan', { planId: 'P-9' }), 'NOT_FOUND');
    assert.match(error.message, /P-9/);
  });

  test('a stopped daemon is reported as DAEMON_NOT_RUNNING', async () => {
    daemon = await startTestDaemon(env, { listen: true });
    await daemon.close();
    daemon = null;
    await rejectsWith(
      new IpcClient(env.paths.socketPath).call('get_status', {}),
      'DAEMON_NOT_RUNNING',
    );
  });

  test('only one process can own the database', async () => {
    daemon = await startTestDaemon(env, { listen: true });
    await rejectsWith(startTestDaemon(env, { listen: true }), 'DATABASE_LOCKED');
    assert.throws(
      () =>
        openDatabase({
          path: env.paths.databaseFile,
          backupDir: env.paths.backupDir,
          migrations: MIGRATIONS,
          now: () => new Date(),
          databaseMaxBytes: 128 * 1024 * 1024,
        }),
      { code: 'DATABASE_LOCKED' },
    );
    const otherProcess = spawnSync(
      process.execPath,
      [
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         try { new DatabaseSync(process.argv[1]).prepare('SELECT count(*) FROM plans').get(); console.log('read'); }
         catch (error) { console.log(error.message); }`,
        env.paths.databaseFile,
      ],
      { encoding: 'utf8' },
    );
    assert.match(otherProcess.stdout, /database is locked/);
    const outsider = new DatabaseSync(env.paths.databaseFile, { timeout: 0 });
    assert.throws(() => outsider.prepare('SELECT count(*) FROM plans').get(), /locked/);
    outsider.close();
  });

  test('the database is released when the daemon stops', async () => {
    daemon = await startTestDaemon(env, { listen: true });
    await daemon.close();
    daemon = await startTestDaemon(env, { listen: true });
  });

  test('a stale socket file left by a crashed daemon does not block startup', async () => {
    mkdirSync(env.paths.runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(env.paths.socketPath, '');
    daemon = await startTestDaemon(env, { listen: true });
    const status = (await new IpcClient(env.paths.socketPath).call('get_status', {})) as {
      activePlans: number;
    };
    assert.equal(status.activePlans, 0);
  });
});
