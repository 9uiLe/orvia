import { fileURLToPath } from 'node:url';
import type { Application } from '../../src/application/application.ts';
import { invokeOperation } from '../../src/application/operations.ts';
import type {
  AgentAdapter,
  AgentInvocation,
  Clock,
  Logger,
  ProcessLauncher,
} from '../../src/application/ports.ts';
import { OrviaError } from '../../src/domain/errors.ts';
import type { OrviaConfig } from '../../src/infrastructure/config.ts';
import type { Migration } from '../../src/infrastructure/sqlite/migrator.ts';
import { startDaemon, type Daemon } from '../../src/interface/daemon/daemon.ts';
import { config as defaultConfig, silentLogger, type TestEnv } from './env.ts';

export const FAKE_AGENT = fileURLToPath(new URL('../fixtures/fake-agent.ts', import.meta.url));

/** Records every invocation so tests can assert where (and whether) an agent was started. */
export class FakeAgent implements AgentAdapter {
  readonly name = 'fake';
  readonly command = process.execPath;
  readonly invocations: AgentInvocation[] = [];
  mode = 'echo';

  buildInvocation: AgentAdapter['buildInvocation'] = (request) => {
    const invocation = {
      command: this.command,
      args: [FAKE_AGENT, this.mode],
      cwd: request.policy.workingDirectory,
      stdin: request.prompt,
    };
    this.invocations.push(invocation);
    return invocation;
  };
}

export interface TestDaemonOptions {
  readonly config?: OrviaConfig;
  readonly migrations?: readonly Migration[];
  readonly clock?: Clock;
  readonly agent?: FakeAgent;
  readonly listen?: boolean;
  readonly launcher?: ProcessLauncher;
  readonly logger?: Logger;
}

export function startTestDaemon(env: TestEnv, options: TestDaemonOptions = {}): Promise<Daemon> {
  return startDaemon({
    paths: env.paths,
    config: options.config ?? defaultConfig(),
    logger: options.logger ?? silentLogger,
    agents: [options.agent ?? new FakeAgent()],
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
