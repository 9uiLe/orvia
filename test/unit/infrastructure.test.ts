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
    assert.deepEqual(config.agents.profiles, {
      codex: { adapter: 'codex' },
      claude: { adapter: 'claude' },
    });
    assert.deepEqual(config.orchestration, {
      max_review_fix_cycles: 3,
      max_review_diff_kb: 256,
    });
  });

  test('default profiles must name a configured profile', () => {
    const profiles = { primary: { adapter: 'codex' } };
    assert.equal(
      validateConfig(
        {
          agents: { profiles },
          orchestration: {
            default_implementation_profile: 'primary',
            default_review_profile: 'primary',
          },
        },
        'test',
      ).orchestration.default_review_profile,
      'primary',
    );
    for (const key of ['default_implementation_profile', 'default_review_profile']) {
      assert.throws(
        () => validateConfig({ agents: { profiles }, orchestration: { [key]: 'missing' } }, 'test'),
        { code: 'CONFIG_INVALID' },
        key,
      );
    }
  });

  test('invalid values are rejected', () => {
    for (const source of [
      '{"storage": {"cache_max_mb": 0}}',
      '{"storage": {"database_max_mb": 1.5}}',
      '{"storage": {"retention_days": -1}}',
      '{"storage": {"pressure_percent": 95, "warning_percent": 90}}',
      '{"storage": {"unknown_key": 1}}',
      '{"log_level": "verbose"}',
      '{"agents": {"profiles": {"Not_Valid": {"adapter": "codex"}}}}',
      '{"agents": {"profiles": {"1st": {"adapter": "codex"}}}}',
      '[]',
      'not json at all {',
    ]) {
      assert.throws(() => parseConfig(source, 'test'), { code: 'CONFIG_INVALID' }, source);
    }
  });

  test('limits are the configured sizes in bytes', () => {
    const limits = storageLimits(validateConfig({}, 'test'));
    assert.equal(limits.databaseMaxBytes, 128 * 1024 * 1024);
    assert.equal(limits.cacheMaxBytes, 512 * 1024 * 1024);
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
    capabilities: ['workspaceRead', 'workspaceWrite'] as const,
    result: null,
  };

  test('codex runs in the bound worktree with its workspace-write sandbox', () => {
    const invocation = codexAdapter.buildInvocation('codex', request);
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
    const invocation = claudeAdapter.buildInvocation('/opt/claude', request);
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

  test('cycle operations are exposed with the storage class their effect needs', () => {
    const classes = Object.fromEntries(
      OPERATIONS.map((operation) => [operation.name, operation.operationClass]),
    );
    assert.deepEqual(
      [
        'start_cycle',
        'get_cycle',
        'get_current_review',
        'get_review',
        'pause_cycle',
        'resume_cycle',
        'cancel_cycle',
      ].map((name) => [name, classes[name]]),
      [
        ['start_cycle', 'agent_run'],
        ['get_cycle', 'read'],
        ['get_current_review', 'read'],
        ['get_review', 'read'],
        ['pause_cycle', 'control'],
        ['resume_cycle', 'agent_run'],
        ['cancel_cycle', 'control'],
      ],
    );
  });

  test('every Work Item mutation requires an explicit workItemId', () => {
    // An operation that also takes a planId may scope itself to the Plan instead of one item.
    const mutations = OPERATIONS.filter((operation) => {
      const { properties } = z.toJSONSchema(operation.input) as {
        properties: Record<string, unknown>;
      };
      return (
        operation.operationClass !== 'read' &&
        'workItemId' in properties &&
        !('planId' in properties)
      );
    });
    assert.ok(mutations.length > 0);
    for (const operation of mutations) {
      const schema = z.toJSONSchema(operation.input) as { required?: string[] };
      assert.ok(schema.required?.includes('workItemId'), operation.name);
    }
  });
});
