import { execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Output exceeded `maxBytes` or stdout could not be preserved as UTF-8 text. */
  readonly truncated: boolean;
}

/**
 * The only place that spawns git. Orvia runs only read-only git commands (plumbing, plus status and diff for review evidence); nothing in this
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
          encoding: 'buffer',
          maxBuffer: maxBytes ?? Infinity,
          // Keep read-only commands from refreshing the index or taking optional locks.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          windowsHide: true,
        },
        (error, output, errors) => {
          const exceededBuffer = error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          let stdout = exceededBuffer
            ? new StringDecoder('utf8').write(output)
            : output.toString('utf8');
          const encoded = Buffer.from(stdout);
          const exceededDecodedBytes = maxBytes !== undefined && encoded.length > maxBytes;
          if (exceededDecodedBytes)
            stdout = new StringDecoder('utf8').write(encoded.subarray(0, maxBytes));
          const truncated = exceededBuffer || exceededDecodedBytes || !encoded.equals(output);
          const stderr = errors.toString('utf8');
          if (error === null) {
            resolve({ exitCode: 0, stdout, stderr, truncated });
            return;
          }
          if (exceededBuffer) {
            resolve({ exitCode: 0, stdout, stderr, truncated: true });
            return;
          }
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout, stderr, truncated });
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
