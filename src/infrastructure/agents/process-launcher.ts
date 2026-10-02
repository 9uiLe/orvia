import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  AgentInvocation,
  ProcessExit,
  ProcessLauncher,
  RunningProcess,
} from '../../application/ports.ts';
import { OrviaError } from '../../domain/errors.ts';

export interface TerminationPolicy {
  /** Time between SIGTERM and SIGKILL. */
  readonly graceMs: number;
  /** Time to wait for the tree to disappear after SIGKILL before reporting failure. */
  readonly killConfirmationMs: number;
}

// How often liveness is re-checked while waiting; there is no event for "process group empty".
const POLL_MS = 10;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

export class NodeProcessLauncher implements ProcessLauncher {
  readonly #policy: TerminationPolicy;

  constructor(policy: TerminationPolicy) {
    this.#policy = policy;
  }

  async resolveCommand(command: string): Promise<string | null> {
    if (isAbsolute(command) || command.includes('/')) {
      return (await isExecutable(command)) ? command : null;
    }
    const extensions =
      process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE').split(';') : [''];
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      for (const extension of extensions) {
        const candidate = join(dir, command + extension);
        if (dir !== '' && (await isExecutable(candidate))) return candidate;
      }
    }
    return null;
  }

  /**
   * On macOS and Linux the agent leads a new process group (`detached`), and the group is
   * signalled as a whole, so descendants that stay in the group are stopped with it.
   * Descendants that create their own session or group (setsid, daemonizing tools) leave
   * it and are not tracked. On Windows only the agent process itself is signalled.
   */
  launch(
    invocation: AgentInvocation,
    onOutput: (chunk: Uint8Array, stream: 'stdout' | 'stderr') => void,
  ): RunningProcess {
    const posix = process.platform !== 'win32';
    const policy = this.#policy;
    // The prompt goes through stdin rather than argv so it does not appear in process listings.
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: posix,
    });
    const pid = child.pid;
    let spawnError: string | null = null;
    let childExited = false;
    const childExit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('error', (error) => {
        spawnError = error.message;
        childExited = true;
        resolve({ code: null, signal: null });
      });
      child.once('exit', (code, signal) => {
        childExited = true;
        resolve({ code, signal });
      });
    });
    const stdioClosed = new Promise<void>((resolve) =>
      child.once('close', () => {
        resolve();
      }),
    );
    child.stdout.on('data', (chunk: Buffer) => {
      onOutput(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      onOutput(chunk, 'stderr');
    });
    child.stdin.on('error', () => {
      // The agent may exit before reading all of stdin; its exit status reports the outcome.
    });
    child.stdin.end(invocation.stdin);

    const target = pid === undefined ? undefined : posix ? -pid : pid;
    const treeAlive = (): boolean => {
      if (target === undefined) return false;
      if (!posix && childExited) return false;
      try {
        process.kill(target, 0);
        return true;
      } catch (error) {
        return errnoCode(error) === 'EPERM';
      }
    };
    const send = (signal: NodeJS.Signals): void => {
      if (target === undefined) return;
      try {
        process.kill(target, signal);
      } catch (error) {
        if (errnoCode(error) !== 'ESRCH') throw error;
      }
    };
    const goneWithin = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      for (;;) {
        if (childExited && !treeAlive()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(POLL_MS);
      }
    };

    let termination: Promise<void> | null = null;
    const terminateTree = (): Promise<void> => {
      termination ??= (async () => {
        if (await goneWithin(0)) return;
        send('SIGTERM');
        if (await goneWithin(policy.graceMs)) return;
        send('SIGKILL');
        if (await goneWithin(policy.killConfirmationMs)) return;
        throw new OrviaError(
          'AGENT_TERMINATION_FAILED',
          `agent process tree (pid ${String(pid)}) did not stop after SIGKILL`,
          {
            pid: pid ?? null,
            graceMs: policy.graceMs,
            killConfirmationMs: policy.killConfirmationMs,
          },
        );
      })().catch((error: unknown) => {
        termination = null;
        throw error;
      });
      return termination;
    };

    const exited = (async (): Promise<ProcessExit> => {
      const exit = await childExit;
      let leftoverError: string | null = null;
      try {
        // Processes the agent left behind belong to the run; stop them before reporting.
        await terminateTree();
      } catch (error) {
        leftoverError = error instanceof Error ? error.message : String(error);
      }
      // A descendant outside the group may still hold the output pipes open.
      const timer = new AbortController();
      await Promise.race([
        stdioClosed,
        sleep(policy.killConfirmationMs, undefined, { signal: timer.signal }).catch(
          () => undefined,
        ),
      ]);
      timer.abort();
      child.stdout.destroy();
      child.stderr.destroy();
      return { exitCode: exit.code, signal: exit.signal, spawnError, leftoverError };
    })();

    return {
      exited,
      terminate: async () => {
        await terminateTree();
        await exited;
      },
    };
  }
}
