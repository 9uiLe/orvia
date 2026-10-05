import { realpath, stat } from 'node:fs/promises';
import type { ChangeEvidence, GitInspector, WorktreeEntry } from '../../application/ports.ts';
import { OrviaError } from '../../domain/errors.ts';
import type { ObservedWorkspace } from '../../domain/workspace.ts';
import type { GitCli } from './git-cli.ts';
import { RepositoryEvidence } from './repository-evidence.ts';
import type {
  CodeSnapshot,
  SourcePage,
  WorkspaceChanges,
} from '../../domain/repository-evidence.ts';

const BRANCH_PREFIX = 'refs/heads/';

/** Identifies the directory instance, not just its path: recreated directories get a new id. */
async function fileId(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class GitWorkspaceInspector implements GitInspector {
  readonly #git: GitCli;

  constructor(git: GitCli) {
    this.#git = git;
  }

  snapshot(worktreeRoot: string): Promise<CodeSnapshot> {
    return new RepositoryEvidence(this.#git).snapshot(worktreeRoot);
  }

  readChanges(
    worktreeRoot: string,
    baseCommit: string,
    maxBytes: number,
    expectedFingerprint?: string,
  ): Promise<WorkspaceChanges> {
    return new RepositoryEvidence(this.#git).readChanges(
      worktreeRoot,
      baseCommit,
      maxBytes,
      expectedFingerprint,
    );
  }

  readSource(
    worktreeRoot: string,
    path: string,
    offset: number,
    maxBytes: number,
    expectedFingerprint?: string,
  ): Promise<SourcePage> {
    return new RepositoryEvidence(this.#git).readSource(
      worktreeRoot,
      path,
      offset,
      maxBytes,
      expectedFingerprint,
    );
  }

  async observe(path: string): Promise<ObservedWorkspace | null> {
    if (!(await exists(path))) return null;
    const dirs = await this.#git.run(path, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
    ]);
    if (dirs.exitCode !== 0) return null;
    const [toplevel, gitDir, commonDir] = dirs.stdout.split('\n');
    if (toplevel === undefined || gitDir === undefined || commonDir === undefined) return null;

    const head = await this.#git.run(path, ['symbolic-ref', '--quiet', 'HEAD']);
    const ref = head.stdout.trim();
    const branch =
      head.exitCode === 0 && ref.startsWith(BRANCH_PREFIX) ? ref.slice(BRANCH_PREFIX.length) : null;

    const [worktreeRoot, worktreeGitDir, repositoryCommonDir] = await Promise.all(
      [toplevel, gitDir, commonDir].map((dir) => realpath(dir)),
    );
    if (worktreeRoot === undefined || worktreeGitDir === undefined) return null;
    if (repositoryCommonDir === undefined) return null;
    return {
      repositoryCommonDir,
      repositoryCommonDirFileId: await fileId(repositoryCommonDir),
      worktreeGitDir,
      worktreeGitDirFileId: await fileId(worktreeGitDir),
      worktreeRoot,
      branch,
    };
  }

  async listWorktrees(repositoryPath: string): Promise<WorktreeEntry[]> {
    const result = await this.#git.run(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
    if (result.exitCode !== 0) {
      throw new OrviaError('VALIDATION_FAILED', 'not a git repository', { repositoryPath });
    }
    const entries: WorktreeEntry[] = [];
    // -z output: attributes are NUL-terminated and records end with an empty attribute.
    for (const record of result.stdout.split('\0\0')) {
      const attributes = record.split('\0').filter((line) => line !== '');
      const worktree = attributes.find((line) => line.startsWith('worktree '));
      if (worktree === undefined) continue;
      const path = worktree.slice('worktree '.length);
      const branchRef = attributes.find((line) => line.startsWith('branch '))?.slice(7) ?? null;
      entries.push({
        path: (await exists(path)) ? await realpath(path) : path,
        branch: branchRef?.startsWith(BRANCH_PREFIX)
          ? branchRef.slice(BRANCH_PREFIX.length)
          : branchRef,
        head: attributes.find((line) => line.startsWith('HEAD '))?.slice(5) ?? null,
        bare: attributes.includes('bare'),
      });
    }
    return entries;
  }

  async resolveCommit(worktreeRoot: string, ref: string): Promise<string | null> {
    // `--end-of-options` keeps a ref from being read as an option.
    const result = await this.#git.run(worktreeRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async changes(
    worktreeRoot: string,
    baseCommit: string,
    maxBytes: number,
  ): Promise<ChangeEvidence> {
    const head = await this.#git.run(worktreeRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    const status = await this.#git.run(
      worktreeRoot,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      maxBytes,
    );
    if (status.exitCode !== 0) {
      throw new OrviaError('VALIDATION_FAILED', 'git status failed in the bound worktree', {
        worktreeRoot,
      });
    }
    const remaining = maxBytes - Buffer.byteLength(status.stdout);
    const diff =
      status.truncated || remaining <= 0
        ? null
        : await this.#git.run(
            worktreeRoot,
            ['diff', '--no-color', '--no-ext-diff', '--no-textconv', baseCommit, '--'],
            remaining,
          );
    if (diff !== null && diff.exitCode !== 0) {
      throw new OrviaError('VALIDATION_FAILED', 'git diff failed in the bound worktree', {
        worktreeRoot,
        baseCommit,
      });
    }
    return {
      baseCommit,
      head: head.exitCode === 0 ? head.stdout.trim() : null,
      status: status.stdout,
      diff: diff?.stdout ?? '',
      complete: diff !== null && !diff.truncated,
    };
  }
}
