import assert from 'node:assert/strict';
import { chmodSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { OrviaError } from '../../src/domain/errors.ts';
import { GitCli } from '../../src/infrastructure/git/git-cli.ts';
import { GitWorkspaceInspector } from '../../src/infrastructure/git/workspace-inspector.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { createRepository, git, snapshotRepository } from '../helpers/git.ts';

describe('repository review evidence', () => {
  let env: TestEnv;
  let repo: string;
  let base: string;
  let inspector: GitWorkspaceInspector;

  beforeEach(() => {
    env = makeTestEnv();
    repo = createRepository(join(env.root, 'repo'));
    base = git(repo, 'rev-parse', 'HEAD');
    inspector = new GitWorkspaceInspector(new GitCli());
  });
  afterEach(() => {
    env.cleanup();
  });

  function code(expected: string): (error: unknown) => boolean {
    return (error) => error instanceof OrviaError && error.code === expected;
  }

  test('fingerprints include index, same-size worktree edits, binary untracked contents, modes and deletions', async () => {
    const initial = await inspector.snapshot(repo);
    writeFileSync(join(repo, 'README.md'), '# changed\n');
    const edited = await inspector.snapshot(repo);
    assert.notEqual(edited.fingerprint, initial.fingerprint);
    git(repo, 'add', 'README.md');
    const staged = await inspector.snapshot(repo);
    assert.notEqual(staged.fingerprint, edited.fingerprint);
    writeFileSync(join(repo, 'README.md'), '# altered\n');
    const status = git(repo, 'status', '--porcelain');
    const first = await inspector.snapshot(repo);
    writeFileSync(join(repo, 'README.md'), '# another\n');
    assert.equal(git(repo, 'status', '--porcelain'), status);
    assert.notEqual((await inspector.snapshot(repo)).fingerprint, first.fingerprint);
    writeFileSync(join(repo, 'raw.bin'), Buffer.from([0, 1, 2]));
    const binary = await inspector.snapshot(repo);
    writeFileSync(join(repo, 'raw.bin'), Buffer.from([0, 1, 3]));
    assert.notEqual((await inspector.snapshot(repo)).fingerprint, binary.fingerprint);
    const beforeMode = await inspector.snapshot(repo);
    chmodSync(join(repo, 'raw.bin'), 0o755);
    assert.notEqual((await inspector.snapshot(repo)).fingerprint, beforeMode.fingerprint);
    const beforeDelete = await inspector.snapshot(repo);
    rmSync(join(repo, 'README.md'));
    assert.notEqual((await inspector.snapshot(repo)).fingerprint, beforeDelete.fingerprint);
    assert.deepEqual(
      initial.files.map((file) => file.path),
      ['README.md'],
    );
    assert.ok(Object.isFrozen(initial.files));
    assert.ok(Object.isFrozen(initial.files[0]));
  });

  test('changes accumulate commits, staged edits, renames, deletions and untracked source from the base', async () => {
    writeFileSync(join(repo, 'committed.ts'), 'export const committed = true;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'later');
    renameSync(join(repo, 'README.md'), join(repo, 'renamed.md'));
    git(repo, 'add', '.');
    writeFileSync(join(repo, 'new.ts'), 'export const added = true;\n');
    const repositoryBefore = snapshotRepository(repo);
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    const changes = await inspector.readChanges(repo, base, 100_000);
    assert.equal(changes.baseCommit, base);
    assert.equal(changes.head, git(repo, 'rev-parse', 'HEAD'));
    assert.equal(changes.complete, true);
    assert.deepEqual(changes.files, [
      { path: 'README.md', status: 'D' },
      { path: 'committed.ts', status: 'A' },
      { path: 'new.ts', status: '??' },
      { path: 'renamed.md', status: 'A' },
    ]);
    assert.match(changes.diff, /export const added/);
    assert.equal(snapshotRepository(repo), repositoryBefore);
    assert.deepEqual(readFileSync(join(repo, '.git', 'index')), indexBefore);
    assert.equal((await inspector.readChanges(repo, base, 10)).complete, false);
  });

  test('source pagination preserves every byte and rejects code changes between pages', async () => {
    const source = Buffer.from('あいう\n');
    writeFileSync(join(repo, 'source.ts'), source);
    const first = await inspector.readSource(repo, 'source.ts', 0, 2);
    assert.equal(first.encoding, 'base64');
    assert.equal(first.nextOffset, 2);
    assert.equal(first.complete, false);
    const rest = await inspector.readSource(repo, 'source.ts', 2, 100, first.fingerprint);
    assert.deepEqual(
      Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(rest.content, 'base64')]),
      source,
    );
    assert.equal(rest.complete, false);
    assert.equal(rest.nextOffset, null);
    assert.equal(
      (await inspector.readSource(repo, 'source.ts', source.length, 100)).complete,
      false,
    );
    writeFileSync(join(repo, 'source.ts'), Buffer.from('えおか\n'));
    await assert.rejects(
      inspector.readSource(repo, 'source.ts', 2, 100, first.fingerprint),
      code('STALE_CODE_STATE'),
    );
    await assert.rejects(
      inspector.readChanges(repo, base, 100_000, first.fingerprint),
      code('STALE_CODE_STATE'),
    );
  });

  test('staged content remains reviewable when worktree content is restored to the base', async () => {
    const original = readFileSync(join(repo, 'README.md'));
    writeFileSync(join(repo, 'README.md'), 'staged-only content\n');
    git(repo, 'add', 'README.md');
    writeFileSync(join(repo, 'README.md'), original);
    const changes = await inspector.readChanges(repo, base, 100_000);
    assert.equal(changes.complete, true);
    assert.deepEqual(changes.files, [{ path: 'README.md', status: 'M (staged)' }]);
    assert.match(changes.diff, /staged-only content/);
  });

  test('binary evidence is partial until the source is read and ignored files do not change code state', async () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored\n');
    writeFileSync(join(repo, 'raw.bin'), Buffer.from([0, 255, 2]));
    const first = await inspector.snapshot(repo);
    writeFileSync(join(repo, 'ignored'), 'not code');
    assert.equal((await inspector.snapshot(repo)).fingerprint, first.fingerprint);
    const changes = await inspector.readChanges(repo, base, 100_000);
    assert.equal(changes.complete, false);
    assert.ok(changes.files.some((file) => file.path === 'raw.bin'));
    const page = await inspector.readSource(repo, 'raw.bin', 0, 100, changes.fingerprint);
    assert.equal(page.complete, true);
    assert.deepEqual(Buffer.from(page.content, 'base64'), Buffer.from([0, 255, 2]));
    await assert.rejects(inspector.readSource(repo, 'missing.ts', 0, 100), code('NOT_FOUND'));
  });

  test('symlinks hash their target name while source reads reject external and administrative paths', async () => {
    const outside = join(env.root, 'outside');
    writeFileSync(outside, 'external secret');
    symlinkSync(outside, join(repo, 'escape'));
    const first = await inspector.snapshot(repo);
    writeFileSync(outside, 'changed external secret');
    assert.equal((await inspector.snapshot(repo)).fingerprint, first.fingerprint);
    await assert.rejects(inspector.readSource(repo, 'escape', 0, 100), code('VALIDATION_FAILED'));
    symlinkSync('.git', join(repo, 'metadata'));
    await assert.rejects(
      inspector.readSource(repo, 'metadata/config', 0, 100),
      code('VALIDATION_FAILED'),
    );
    await assert.rejects(
      inspector.readSource(repo, '../outside', 0, 100),
      code('VALIDATION_FAILED'),
    );
    await assert.rejects(inspector.readSource(repo, outside, 0, 100), code('VALIDATION_FAILED'));
    await assert.rejects(
      inspector.readSource(repo, '.git/config', 0, 100),
      code('VALIDATION_FAILED'),
    );
  });

  test('incomplete git listings and unsupported submodules cannot produce a complete fingerprint', async () => {
    class TruncatedGit extends GitCli {
      override async run(cwd: string, args: readonly string[], maxBytes?: number) {
        const result = await super.run(cwd, args, maxBytes);
        return args[0] === 'ls-files' ? { ...result, truncated: true } : result;
      }
    }
    await assert.rejects(
      new GitWorkspaceInspector(new TruncatedGit()).snapshot(repo),
      code('VALIDATION_FAILED'),
    );
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${base},submodule`);
    await assert.rejects(inspector.snapshot(repo), code('VALIDATION_FAILED'));
  });

  test('mutation while collecting content cannot be reported as a complete code state', async () => {
    class MutatingGit extends GitCli {
      #trees = 0;
      override async run(cwd: string, args: readonly string[], maxBytes?: number) {
        const result = await super.run(cwd, args, maxBytes);
        if (args[0] === 'ls-tree' && ++this.#trees === 2) {
          writeFileSync(join(repo, 'README.md'), 'changed during collection\n');
        }
        return result;
      }
    }
    await assert.rejects(
      new GitWorkspaceInspector(new MutatingGit()).snapshot(repo),
      code('STALE_CODE_STATE'),
    );
  });
});
