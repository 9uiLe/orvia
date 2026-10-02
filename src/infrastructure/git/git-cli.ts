import { execFile } from 'node:child_process';

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout reached `maxBytes` and git was stopped; `stdout` holds what was read. */
  readonly truncated: boolean;
}

/**
 * The only place that spawns git. Orvia uses read-only plumbing commands; nothing in this
 * code base creates, moves, or deletes branches, worktrees, commits, or repositories.
 */
export class GitCli {
  readonly #executable: string;

  constructor(executable = 'git') {
    this.#executable = executable;
  }

  run(cwd: string, args: readonly string[], maxBytes?: number): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.#executable,
        ['-C', cwd, ...args],
        {
          encoding: 'utf8',
          ...(maxBytes === undefined ? {} : { maxBuffer: maxBytes }),
          // Keep read-only commands from refreshing the index or taking optional locks.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr, truncated: false });
            return;
          }
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            resolve({ exitCode: 0, stdout, stderr, truncated: true });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout, stderr, truncated: false });
            return;
          }
          reject(new Error(error.message, { cause: error }));
        },
      );
    });
  }

  async version(): Promise<string | null> {
    try {
      const result = await this.run('.', ['--version']);
      return result.exitCode === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }
}
