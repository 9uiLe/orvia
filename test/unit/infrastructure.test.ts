import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as z from 'zod/v4';
import { OPERATIONS } from '../../src/application/operations.ts';
import { claudeAdapter, codexAdapter } from '../../src/infrastructure/agents/adapters.ts';
import { parseConfig, storageLimits, validateConfig } from '../../src/infrastructure/config.ts';
import { resolvePaths } from '../../src/infrastructure/paths.ts';

const platform = (name: NodeJS.Platform, env: Record<string, string> = {}) => ({
  platform: name,
  env,
  home: '/home/u',
  tmp: '/tmp',
  user: 'u',
  uid: 501,
});

describe('configuration', () => {
  test('an empty file yields the documented defaults', () => {
    const config = validateConfig({}, 'test');
    assert.deepEqual(config.storage, {
      database_max_mb: 128,
      cache_max_mb: 512,
      retention_days: 7,
      max_completed_runs_per_work_item: 5,
      pressure_percent: 70,
      warning_percent: 90,
    });
    assert.equal(config.log_level, 'info');
    assert.equal(config.agents.termination_grace_ms, 10_000);
    assert.equal(config.agents.kill_confirmation_ms, 5_000);
  });

  test('invalid values are rejected', () => {
    for (const source of [
      '{"storage": {"cache_max_mb": 0}}',
      '{"storage": {"database_max_mb": 1.5}}',
      '{"storage": {"retention_days": -1}}',
      '{"storage": {"pressure_percent": 95, "warning_percent": 90}}',
      '{"storage": {"unknown_key": 1}}',
      '{"log_level": "verbose"}',
      '[]',
      'not json at all {',
    ]) {
      assert.throws(() => parseConfig(source, 'test'), { code: 'CONFIG_INVALID' }, source);
    }
  });

  test('the database limit must leave room above the maintenance reserve', () => {
    const config = validateConfig({ storage: { database_max_mb: 3 } }, 'test');
    assert.throws(() => storageLimits(config, 4_096_000), { code: 'CONFIG_INVALID' });
    const limits = storageLimits(validateConfig({}, 'test'), 4_096_000);
    assert.equal(limits.databaseMaxBytes, 128 * 1024 * 1024);
  });
});

describe('paths', () => {
  test('Linux follows XDG base directories', () => {
    const paths = resolvePaths(platform('linux', { XDG_RUNTIME_DIR: '/run/user/501' }));
    assert.equal(paths.configFile, '/home/u/.config/orvia/config.json');
    assert.equal(paths.databaseFile, '/home/u/.local/share/orvia/state.db');
    assert.equal(paths.cacheDir, '/home/u/.cache/orvia');
    assert.equal(paths.socketPath, '/run/user/501/orvia/orvia.sock');
  });

  test('macOS uses Application Support and Caches', () => {
    const paths = resolvePaths(platform('darwin'));
    assert.equal(paths.databaseFile, '/home/u/Library/Application Support/orvia/state.db');
    assert.equal(paths.cacheDir, '/home/u/Library/Caches/orvia');
    assert.equal(paths.socketPath, '/tmp/orvia-501/orvia.sock');
  });

  test('environment overrides win', () => {
    const paths = resolvePaths(platform('linux', { ORVIA_DATA_DIR: '/x/data' }));
    assert.equal(paths.databaseFile, '/x/data/state.db');
  });
});

describe('agent adapters', () => {
  const request = {
    policy: {
      workingDirectory: '/wt/a',
      writableRoots: ['/wt/a', '/r/.git/worktrees/a', '/r/.git'],
    },
    prompt: 'secret instructions',
  };

  test('codex runs in the bound worktree with its workspace-write sandbox', () => {
    const invocation = codexAdapter().buildInvocation(request);
    assert.equal(invocation.cwd, '/wt/a');
    assert.deepEqual(invocation.args, [
      'exec',
      '--sandbox',
      'workspace-write',
      '--cd',
      '/wt/a',
      '--add-dir',
      '/r/.git/worktrees/a',
      '--add-dir',
      '/r/.git',
      '-',
    ]);
    assert.equal(invocation.stdin, 'secret instructions');
  });

  test('claude runs in the bound worktree; the prompt is passed on stdin, not argv', () => {
    const invocation = claudeAdapter('/opt/claude').buildInvocation(request);
    assert.equal(invocation.command, '/opt/claude');
    assert.equal(invocation.cwd, '/wt/a');
    assert.ok(!invocation.args.includes('secret instructions'));
    assert.equal(invocation.stdin, 'secret instructions');
  });
});

describe('operation registry', () => {
  test('names are unique and every input schema converts to JSON Schema for MCP', () => {
    const names = OPERATIONS.map((operation) => operation.name);
    assert.equal(new Set(names).size, names.length);
    for (const operation of OPERATIONS) {
      const schema = z.toJSONSchema(operation.input) as { type: string };
      assert.equal(schema.type, 'object', operation.name);
    }
  });

  test('every Work Item mutation requires an explicit workItemId', () => {
    for (const name of [
      'start_run',
      'pause_work_item',
      'resume_work_item',
      'submit_feedback',
      'bind_workspace',
    ]) {
      const operation = OPERATIONS.find((candidate) => candidate.name === name);
      const schema = z.toJSONSchema(operation?.input ?? z.object({})) as { required?: string[] };
      assert.ok(schema.required?.includes('workItemId'), name);
    }
  });
});
