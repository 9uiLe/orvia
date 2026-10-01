import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { OPERATIONS } from '../../src/application/operations.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';

const CLI = fileURLToPath(new URL('../../src/interface/cli/main.ts', import.meta.url));

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe('MCP server over stdio', () => {
  let env: TestEnv;
  let daemon: Daemon | null;

  before(async () => {
    env = makeTestEnv();
    daemon = await startTestDaemon(env, { listen: true });
  });
  after(async () => {
    await daemon?.close();
    env.cleanup();
  });

  const serverParams = () => ({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...(process.env as Record<string, string>), ...env.env },
    stderr: 'pipe' as const,
  });

  test('a client on the current protocol lists and calls tools', async () => {
    const client = new Client({ name: 'orvia-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport(serverParams()));
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        OPERATIONS.map((operation) => operation.name).sort(),
      );
      for (const tool of tools) {
        const operation = OPERATIONS.find((candidate) => candidate.name === tool.name);
        assert.equal(
          tool.annotations?.readOnlyHint,
          operation?.operationClass === 'read',
          `${tool.name} readOnlyHint`,
        );
      }
      const created = (await client.callTool({
        name: 'create_plan',
        arguments: { title: 'From MCP' },
      })) as ToolResult;
      assert.equal(created.isError, undefined);
      assert.equal(created.structuredContent?.['id'], 'P-1');
    } finally {
      await client.close();
    }
  });

  test('a client on an earlier protocol revision (SDK v1) also works', async () => {
    const client = new LegacyClient({ name: 'orvia-legacy-test', version: '0.0.0' });
    await client.connect(new LegacyStdio(serverParams()));
    try {
      const status = (await client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
      assert.equal(status.structuredContent?.['activePlans'], 1);
      const invalid = (await client.callTool({
        name: 'pause_work_item',
        arguments: { workItemId: 'W-404' },
      })) as ToolResult;
      assert.equal(invalid.isError, true);
      assert.equal((invalid.structuredContent?.['error'] as { code: string }).code, 'NOT_FOUND');
    } finally {
      await client.close();
    }
  });

  test('tools report DAEMON_NOT_RUNNING when the daemon is down', async () => {
    await daemon?.close();
    daemon = null;
    const client = new Client({ name: 'orvia-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport(serverParams()));
    try {
      const result = (await client.callTool({ name: 'get_status', arguments: {} })) as ToolResult;
      assert.equal(result.isError, true);
      assert.equal(
        (result.structuredContent?.['error'] as { code: string }).code,
        'DAEMON_NOT_RUNNING',
      );
    } finally {
      await client.close();
    }
  });
});
