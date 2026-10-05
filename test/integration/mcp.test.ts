import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { OPERATIONS } from '../../src/application/operations.ts';
import type { Checkpoint, DesignRevision, WorkReport } from '../../src/domain/checkpoint.ts';
import type { AgentRun, Decision } from '../../src/domain/records.ts';
import type { SourcePage, WorkspaceChanges } from '../../src/domain/repository-evidence.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { FakeAgent, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { createRepository } from '../helpers/git.ts';

const CLI = fileURLToPath(new URL('../../src/interface/cli/main.ts', import.meta.url));

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe('MCP server over stdio', () => {
  let env: TestEnv;
  let daemon: Daemon | null;
  let agent: FakeAgent;

  before(async () => {
    env = makeTestEnv();
    agent = new FakeAgent();
    agent.manualStep = {
      result: {
        status: 'completed',
        summary: 'The fixture change is ready for app evaluation.',
        commands: [{ command: 'fixture check', exitCode: 0, summary: 'agent-reported pass' }],
        unresolved: '',
        requiredDecision: '',
      } satisfies WorkReport,
    };
    daemon = await startTestDaemon(env, { listen: true, agent });
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

  test('MCP reports that legacy cycles are disabled by default', async () => {
    const client = new Client({ name: 'orvia-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport(serverParams()));
    try {
      const profiles = (await client.callTool({
        name: 'list_agent_profiles',
        arguments: {},
      })) as ToolResult;
      assert.equal(profiles.structuredContent?.['legacyCyclesEnabled'], false);
      for (const request of [
        {
          name: 'start_cycle',
          arguments: { workItemId: 'W-404', mode: 'implement', instructions: 'Make a change' },
        },
        { name: 'resume_cycle', arguments: { cycleId: 'C-404' } },
      ]) {
        const result = (await client.callTool(request)) as ToolResult;
        assert.equal(result.isError, true);
        assert.equal(
          (result.structuredContent?.['error'] as { code: string }).code,
          'LEGACY_CYCLES_DISABLED',
        );
      }
    } finally {
      await client.close();
    }
  });

  test('a client on an earlier protocol revision (2025-06-18) also works', async () => {
    // Raw newline-delimited JSON-RPC, as older clients send it: initialize handshake first.
    const params = serverParams();
    const child = spawn(params.command, params.args, { env: params.env, stdio: 'pipe' });
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as { id?: number } & Record<string, unknown>;
      if (typeof message.id === 'number') pending.get(message.id)?.(message);
    });
    let nextId = 0;
    const request = (method: string, body: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: body }) + '\n');
      });
    try {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'orvia-legacy-test', version: '0.0.0' },
      });
      assert.equal((init['result'] as { protocolVersion: string }).protocolVersion, '2025-06-18');
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );

      const status = await request('tools/call', { name: 'get_status', arguments: {} });
      const statusResult = status['result'] as ToolResult;
      assert.equal(statusResult.structuredContent?.['activePlans'], 1);

      const invalid = await request('tools/call', {
        name: 'pause_work_item',
        arguments: { workItemId: 'W-404' },
      });
      const invalidResult = invalid['result'] as ToolResult;
      assert.equal(invalidResult.isError, true);
      assert.equal(
        (invalidResult.structuredContent?.['error'] as { code: string }).code,
        'NOT_FOUND',
      );
    } finally {
      child.kill();
    }
  });

  test('the app-led checkpoint workflow crosses MCP and IPC with reports and human decisions', async () => {
    assert.ok(daemon);
    const client = new Client({ name: 'orvia-checkpoint-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport(serverParams()));
    const invoke = async <T>(name: string, input: Record<string, unknown> = {}): Promise<T> => {
      const result = (await client.callTool({ name, arguments: input })) as ToolResult;
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.ok(result.structuredContent, name);
      return result.structuredContent as T;
    };
    const refused = async (name: string, input: Record<string, unknown>, code: string) => {
      const result = (await client.callTool({ name, arguments: input })) as ToolResult;
      assert.equal(result.isError, true);
      assert.equal((result.structuredContent?.['error'] as { code: string }).code, code);
    };
    const release = join(env.root, 'checkpoint-release');
    try {
      const repo = createRepository(join(env.root, 'checkpoint-repo'));
      const plan = await invoke<{ id: string }>('create_plan', { title: 'Checkpoint workflow' });
      const item = await invoke<WorkItem>('create_work_item', { planId: plan.id, title: 'Change' });
      await invoke('bind_workspace', { workItemId: item.id, worktreePath: repo });
      const input = {
        workItemId: item.id,
        profileId: 'fake',
        instructions: 'Implement the agreed fixture change.',
        endCondition: 'Stop after the fixture check and report unresolved work.',
      };
      await refused('prepare_prompt', input, 'DESIGN_NOT_CONFIRMED');
      const oldStart = (await client.callTool({
        name: 'start_run',
        arguments: { workItemId: item.id, profileId: 'fake', instructions: 'send free text' },
      })) as ToolResult;
      assert.equal(oldStart.isError, true);

      const design = await invoke<DesignRevision>('confirm_design', {
        planId: plan.id,
        goal: 'Make the fixture change available for human review.',
        scope: 'The bound repository.',
        constraints: 'Preserve workspace identity.',
        acceptanceCriteria: 'The report and source can be inspected before a human decision.',
      });
      const prepared = await invoke<Checkpoint>('prepare_prompt', input);
      assert.equal(prepared.state, 'prepared');
      assert.equal(prepared.designRevisionId, design.id);
      assert.equal(prepared.profileId, 'fake');
      assert.equal(prepared.preparedContext.workspace.worktreeRoot, repo);
      assert.ok(prepared.prompt.includes(input.instructions));
      assert.ok(prepared.prompt.includes(input.endCondition));
      assert.ok(prepared.prompt.includes(design.goal));
      assert.equal(agent.invocations.length, 0, 'preparation does not launch an agent');

      const report = agent.manualStep?.result as WorkReport;
      agent.manualStep = { result: report, waitFor: release };
      const run = await invoke<AgentRun>('start_run', { checkpointId: prepared.id });
      assert.equal(agent.invocations[0]?.stdin, prepared.prompt);
      const binary = Buffer.from([0, 255, 1, 128]);
      writeFileSync(join(repo, 'new-source.ts'), 'export const answer = 42;\n');
      writeFileSync(join(repo, 'new-binary.bin'), binary);
      writeFileSync(release, '');
      await daemon.app.runs.waitForRun(run.id);
      const inspected = await invoke<{
        checkpoint: Checkpoint;
        design: DesignRevision;
        run: AgentRun;
        verificationSource: string;
        changedFiles: string[];
      }>('get_checkpoint', { checkpointId: prepared.id });
      assert.equal(inspected.checkpoint.state, 'awaiting_review');
      assert.equal(inspected.run.status, 'succeeded');
      assert.deepEqual(inspected.checkpoint.report, report);
      assert.equal(inspected.verificationSource, 'agent_reported');
      assert.equal(inspected.design.id, design.id);
      assert.deepEqual(inspected.changedFiles, ['new-binary.bin', 'new-source.ts']);
      await refused('prepare_prompt', input, 'HUMAN_REVIEW_REQUIRED');

      const changes = await invoke<WorkspaceChanges & { matchesReport: boolean }>(
        'get_checkpoint_changes',
        { checkpointId: prepared.id, maxBytes: 100_000 },
      );
      assert.equal(changes.complete, false, 'binary content requires source retrieval');
      assert.equal(changes.matchesReport, true);
      assert.deepEqual(changes.files.map((file) => file.path).sort(), [
        'new-binary.bin',
        'new-source.ts',
      ]);
      assert.match(changes.diff, /export const answer = 42/);
      const source = await invoke<SourcePage>('get_checkpoint_source', {
        checkpointId: prepared.id,
        path: 'new-source.ts',
        maxBytes: 100_000,
        expectedFingerprint: changes.fingerprint,
      });
      assert.equal(source.encoding, 'base64');
      assert.equal(
        Buffer.from(source.content, 'base64').toString('utf8'),
        'export const answer = 42;\n',
      );
      const pages: Buffer[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page: SourcePage = await invoke<SourcePage>('get_checkpoint_source', {
          checkpointId: prepared.id,
          path: 'new-binary.bin',
          offset,
          maxBytes: 2,
          expectedFingerprint: changes.fingerprint,
        });
        assert.equal(page.encoding, 'base64');
        pages.push(Buffer.from(page.content, 'base64'));
        offset = page.nextOffset;
      }
      assert.deepEqual(Buffer.concat(pages), binary);

      const evaluation = 'The app inspected the source and the agent-reported commands.';
      const decision = 'Continue with a second checkpoint to finish the agreed change.';
      const reviewed = await invoke<Checkpoint>('record_checkpoint_review', {
        checkpointId: prepared.id,
        evaluation,
        action: 'continue',
        decision,
      });
      assert.equal(reviewed.state, 'reviewed');
      const next = await invoke<Checkpoint>('prepare_prompt', {
        ...input,
        instructions: 'Finish the change.',
      });
      assert.equal(next.previousCheckpointId, prepared.id);
      for (const text of [report.summary, evaluation, decision])
        assert.ok(next.prompt.includes(text));
      assert.equal(agent.invocations.length, 1);
      agent.manualStep = { result: report };
      const nextRun = await invoke<AgentRun>('start_run', { checkpointId: next.id });
      assert.equal(agent.invocations[1]?.stdin, next.prompt);
      await daemon.app.runs.waitForRun(nextRun.id);
      const secondReport = await invoke<{ checkpoint: Checkpoint }>('get_checkpoint', {
        checkpointId: next.id,
      });
      assert.equal(secondReport.checkpoint.state, 'awaiting_review');
      assert.deepEqual(secondReport.checkpoint.report, report);
      const complete = await invoke<Checkpoint>('record_checkpoint_review', {
        checkpointId: next.id,
        evaluation: 'The app accepts the finished scope after inspecting the second report.',
        action: 'complete',
        decision: 'The human accepts the change and completes this Work Item.',
      });
      assert.equal(complete.reviews.at(-1)?.action, 'complete');
      const final = await invoke<{ workItem: WorkItem; checkpoints: Checkpoint[] }>(
        'get_work_item',
        { workItemId: item.id },
      );
      assert.equal(final.workItem.status, 'completed');
      assert.deepEqual(
        final.checkpoints.map((checkpoint) => checkpoint.id),
        [next.id, prepared.id],
      );
      const judgment = await invoke<{ decisions: Decision[] }>('get_checkpoint', {
        checkpointId: next.id,
      });
      assert.equal(
        judgment.decisions[0]?.body,
        'The human accepts the change and completes this Work Item.',
      );
    } finally {
      writeFileSync(release, '');
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
