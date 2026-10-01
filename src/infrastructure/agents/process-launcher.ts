import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import type {
  AgentInvocation,
  ProcessExit,
  ProcessLauncher,
  RunningProcess,
} from '../../application/ports.ts';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export class NodeProcessLauncher implements ProcessLauncher {
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

  launch(invocation: AgentInvocation, onOutput: (chunk: Uint8Array) => void): RunningProcess {
    // The prompt goes through stdin rather than argv so it does not appear in process listings.
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const exited = new Promise<ProcessExit>((resolve) => {
      child.once('error', (error) => {
        resolve({ exitCode: null, signal: null, spawnError: error.message });
      });
      child.once('close', (exitCode, signal) => {
        resolve({ exitCode, signal, spawnError: null });
      });
    });
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.stdin.on('error', () => {
      // The agent may exit before reading all of stdin; its exit status reports the outcome.
    });
    child.stdin.end(invocation.stdin);
    return {
      exited,
      cancel: () => {
        child.kill('SIGTERM');
      },
    };
  }
}
