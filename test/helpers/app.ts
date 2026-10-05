import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Application } from '../../src/application/application.ts';
import { STAGE_ROLES } from '../../src/application/cycle-prompts.ts';
import { invokeOperation } from '../../src/application/operations.ts';
import type {
  AgentAdapter,
  AgentInvocation,
  Clock,
  Logger,
  ProcessLauncher,
} from '../../src/application/ports.ts';
import { AGENT_CAPABILITIES, type AgentCapability } from '../../src/domain/agent-profile.ts';
import type { Checkpoint } from '../../src/domain/checkpoint.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import type { WorkItemId } from '../../src/domain/ids.ts';
import type { AgentRun } from '../../src/domain/records.ts';
import type { OrviaConfig } from '../../src/infrastructure/config.ts';
import type { Migration } from '../../src/infrastructure/sqlite/migrator.ts';
import { startDaemon, type Daemon } from '../../src/interface/daemon/daemon.ts';
import { config as defaultConfig, silentLogger, type TestEnv } from './env.ts';

export const FAKE_AGENT = fileURLToPath(new URL('../fixtures/fake-agent.ts', import.meta.url));

/** One scripted agent run: what it prints to stdout, how it exits, and whether it waits. */
export interface FakeStep {
  /** Serialized to JSON as the structured result on stdout. */
  readonly result?: unknown;
  /** Printed verbatim instead of `result`, for malformed output. */
  readonly stdout?: string;
  readonly exitCode?: number;
  /** Waits until this file exists before writing stdout (or until terminated). */
  readonly waitFor?: string;
  /** Waits until this file exists after writing stdout, before exiting. */
  readonly holdFor?: string;
}

export type FakeRole = keyof typeof STAGE_ROLES;

/**
 * A fake adapter. Records every invocation so tests can assert where (and whether) an agent
 * was started and what it was allowed. Cycle stages are answered from `script`, per role, in
 * order; the role is read from the prompt's role line. Other runs use `mode`.
 */
export class FakeAgent implements AgentAdapter {
  readonly id: string;
  readonly defaultCommand = process.execPath;
  capabilities: readonly AgentCapability[] = [...AGENT_CAPABILITIES];
  readonly invocations: (AgentInvocation & {
    role: FakeRole | null;
    granted: readonly AgentCapability[];
  })[] = [];
  mode = 'echo';
  manualStep: FakeStep | null = null;
  script: Partial<Record<FakeRole, FakeStep[]>> = {};
  readonly #stepDir: string;

  constructor(id = 'fake', stepDir = mkdtempSync(join(tmpdir(), 'orvia-fake-'))) {
    this.id = id;
    this.#stepDir = stepDir;
  }

  buildInvocation: AgentAdapter['buildInvocation'] = (command, request) => {
    const role = (Object.keys(STAGE_ROLES) as FakeRole[]).find((candidate) =>
      request.prompt.includes(STAGE_ROLES[candidate]),
    );
    let args = [FAKE_AGENT, this.mode];
    if (role !== undefined) {
      const step = this.script[role]?.shift() ?? {
        exitCode: 99,
        stdout: `no scripted ${role} step`,
      };
      const file = join(this.#stepDir, `${this.id}-step-${String(this.invocations.length)}.json`);
      writeFileSync(file, JSON.stringify(step));
      args = [FAKE_AGENT, `step:${file}`];
    } else if (this.manualStep !== null) {
      const file = join(this.#stepDir, `${this.id}-manual-${String(this.invocations.length)}.json`);
      writeFileSync(file, JSON.stringify(this.manualStep));
      args = [FAKE_AGENT, `step:${file}`];
    }
    const invocation = {
      command,
      args,
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    };
    this.invocations.push({ ...invocation, role: role ?? null, granted: request.capabilities });
    return invocation;
  };

  resultStdoutBytes: AgentAdapter['resultStdoutBytes'] = (resultBytes) => resultBytes;

  extractResult: AgentAdapter['extractResult'] = (stdout) =>
    stdout.trim() === '' ? null : stdout.trim();
}

export interface TestDaemonOptions {
  readonly config?: OrviaConfig;
  readonly migrations?: readonly Migration[];
  readonly clock?: Clock;
  readonly agent?: FakeAgent;
  /** Additional adapters, e.g. a separate reviewer. */
  readonly agents?: readonly FakeAgent[];
  /**
   * Agent Profiles; by default one per fake adapter, named like the adapter. Profiles in
   * `config` are ignored either way, since the bundled adapters are not loaded.
   */
  readonly profiles?: Record<
    string,
    { adapter: string; command?: string; capabilities?: AgentCapability[] }
  >;
  readonly listen?: boolean;
  readonly launcher?: ProcessLauncher;
  readonly logger?: Logger;
}

export function startTestDaemon(env: TestEnv, options: TestDaemonOptions = {}): Promise<Daemon> {
  const adapters = [options.agent ?? new FakeAgent(), ...(options.agents ?? [])];
  const base = options.config ?? defaultConfig();
  const config: OrviaConfig = {
    ...base,
    agents: {
      ...base.agents,
      profiles:
        options.profiles ??
        Object.fromEntries(adapters.map((adapter) => [adapter.id, { adapter: adapter.id }])),
    },
  };
  return startDaemon({
    paths: env.paths,
    config,
    logger: options.logger ?? silentLogger,
    adapters,
    listen: options.listen ?? false,
    ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
  });
}

/** Calls an operation the same way the IPC server and MCP tools do. */
export async function call<T = Record<string, unknown>>(
  app: Application,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  return (await invokeOperation(app, operation, input)) as T;
}

export async function rejectsWith(promise: Promise<unknown>, code: string): Promise<OrviaError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OrviaError && error.code === code) return error;
    throw new Error(`expected ${code}, got ${String(error)}`, { cause: error });
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Polls until `condition` holds, failing after about five seconds. */
export async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!condition()) throw new Error('condition was not reached');
}

export async function startPreparedRun(
  app: Application,
  input: { workItemId: WorkItemId; profileId: string; instructions: string },
): Promise<AgentRun> {
  const item = app.deps.store.workItems.get(input.workItemId);
  if (item === null) throw new Error(`fixture Work Item ${input.workItemId} was not found`);
  if (app.deps.store.designRevisions.latest(item.planId) === null) {
    await call(app, 'confirm_design', {
      planId: item.planId,
      goal: 'Exercise the configured agent in the bound workspace.',
      scope: 'The test Work Item.',
      constraints: 'Preserve the fixture repository and its workspace identity.',
      acceptanceCriteria: 'The agent lifecycle satisfies the test assertions.',
    });
  }
  const previous = app.deps.store.checkpoints.latestDispatched(item.id);
  if (previous?.state === 'awaiting_review') {
    await call(app, 'record_checkpoint_review', {
      checkpointId: previous.id,
      evaluation: 'The fixture run was inspected against its lifecycle assertions.',
      action: 'continue',
      decision: 'Continue with the next fixture run.',
    });
  }
  const checkpoint = await call<Checkpoint>(app, 'prepare_prompt', {
    workItemId: input.workItemId,
    profileId: input.profileId,
    instructions: input.instructions,
    endCondition: 'Finish the requested fixture invocation and report its result.',
  });
  return call<AgentRun>(app, 'start_run', { checkpointId: checkpoint.id });
}
