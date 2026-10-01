import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

// Orvia's GitCli inherits process.env, so isolate both it and the fixtures from user config
// such as commit signing or hooks.
const ISOLATED = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Orvia Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Orvia Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
Object.assign(process.env, ISOLATED);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED },
  }).trim();
}

/** A repository with one commit on `main`. Returns its real path. */
export function createRepository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(join(path, 'README.md'), '# fixture\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'initial');
  return realpathSync(path);
}

export function addWorktree(repository: string, path: string, branch: string): string {
  git(repository, 'worktree', 'add', '--quiet', '-b', branch, path);
  return realpathSync(path);
}

/** Everything about a repository that storage cleanup must leave untouched. */
export function snapshotRepository(repository: string): string {
  return JSON.stringify({
    head: git(repository, 'rev-parse', 'HEAD'),
    refs: git(repository, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: git(repository, 'worktree', 'list', '--porcelain'),
    status: git(repository, 'status', '--porcelain', '--untracked-files=all'),
    index: git(repository, 'ls-files', '--stage'),
    objects: git(repository, 'count-objects', '-v'),
  });
}
