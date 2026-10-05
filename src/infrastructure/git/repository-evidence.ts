import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  CodeSnapshot,
  SourcePage,
  WorkspaceChanges,
} from '../../domain/repository-evidence.ts';
import { OrviaError } from '../../domain/errors.ts';
import type { GitCli } from './git-cli.ts';

interface Context {
  root: string;
  administrative: readonly string[];
}

interface Metadata {
  head: string;
  index: string;
  tree: string;
  untracked: readonly string[];
  records: ReadonlyMap<string, readonly string[]>;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function stale(): never {
  throw new OrviaError('STALE_CODE_STATE', 'the code state changed while collecting evidence');
}

function sameSnapshot(a: CodeSnapshot, b: CodeSnapshot): void {
  if (a.fingerprint !== b.fingerprint) stale();
}

function expectSnapshot(snapshot: CodeSnapshot, expected?: string): void {
  if (expected !== undefined && snapshot.fingerprint !== expected) stale();
}

function nulRecords(output: string): string[] {
  if (output === '') return [];
  if (!output.endsWith('\0') || output.includes('\ufffd')) {
    throw new OrviaError('VALIDATION_FAILED', 'git returned incomplete or unsupported path data');
  }
  return output.slice(0, -1).split('\0');
}

export class RepositoryEvidence {
  readonly #git: GitCli;

  constructor(git: GitCli) {
    this.#git = git;
  }

  async #command(root: string, args: readonly string[]): Promise<string> {
    const result = await this.#git.run(root, args);
    if (result.exitCode !== 0 || result.truncated) {
      throw new OrviaError('VALIDATION_FAILED', 'could not collect complete git evidence', {
        command: args[0],
      });
    }
    return result.stdout;
  }

  async #context(root: string): Promise<Context> {
    const canonical = await realpath(root);
    const dirs = await this.#command(canonical, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir',
    ]);
    const [top, gitDir, commonDir] = dirs.trimEnd().split('\n');
    if (
      top === undefined ||
      gitDir === undefined ||
      commonDir === undefined ||
      (await realpath(top)) !== canonical
    ) {
      throw new OrviaError('WORKSPACE_MISMATCH', 'evidence requires the bound worktree root');
    }
    return {
      root: canonical,
      administrative: await Promise.all([gitDir, commonDir].map((dir) => realpath(dir))),
    };
  }

  async #metadata(context: Context): Promise<Metadata> {
    const head = (await this.#command(context.root, ['rev-parse', '--verify', 'HEAD'])).trim();
    const index = await this.#command(context.root, ['ls-files', '--stage', '-z']);
    const tree = await this.#command(context.root, ['ls-tree', '-r', '-z', head]);
    const untracked = nulRecords(
      await this.#command(context.root, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    const records = new Map<string, string[]>();
    for (const [kind, output] of [
      ['head', tree],
      ['index', index],
    ]) {
      if (output === undefined) continue;
      for (const record of nulRecords(output)) {
        const tab = record.indexOf('\t');
        if (tab < 0) throw new OrviaError('VALIDATION_FAILED', 'invalid git file metadata');
        const entry = record.slice(0, tab);
        if (entry.startsWith('160000 ')) {
          throw new OrviaError('VALIDATION_FAILED', 'submodule code snapshots are unsupported');
        }
        const path = record.slice(tab + 1);
        const values = records.get(path) ?? [];
        values.push(`${kind}:${entry}`);
        records.set(path, values);
      }
    }
    for (const path of untracked) if (!records.has(path)) records.set(path, []);
    return { head, index, tree, untracked, records };
  }

  #assertPath(context: Context, path: string): void {
    if (!inside(context.root, path) || context.administrative.some((dir) => inside(dir, path))) {
      throw new OrviaError(
        'VALIDATION_FAILED',
        'source path escapes the worktree or enters git metadata',
      );
    }
  }

  async #path(context: Context, path: string, followFinal: boolean): Promise<string> {
    if (
      path === '' ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes('..') ||
      path.split(/[\\/]/).includes('.git')
    ) {
      throw new OrviaError('VALIDATION_FAILED', 'source path must be relative to the worktree');
    }
    const absolute = resolve(context.root, path);
    this.#assertPath(context, absolute);
    const parent = await realpath(resolve(absolute, '..'));
    this.#assertPath(context, parent);
    if (followFinal) this.#assertPath(context, await realpath(absolute));
    return absolute;
  }

  async #open(context: Context, path: string): Promise<FileHandle> {
    const absolute = await this.#path(context, path, true);
    const canonical = await realpath(absolute);
    const before = await lstat(canonical, { bigint: true });
    if (!before.isFile())
      throw new OrviaError('VALIDATION_FAILED', 'source path is not a regular file');
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      this.#assertPath(context, await realpath(absolute));
      const info = await handle.stat({ bigint: true });
      if (
        (await realpath(absolute)) !== canonical ||
        info.dev !== before.dev ||
        info.ino !== before.ino
      )
        stale();
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #contentFingerprint(context: Context, path: string): Promise<string> {
    try {
      const absolute = await this.#path(context, path, false);
      const before = await lstat(absolute, { bigint: true });
      const hash = createHash('sha256').update(`${before.mode}:`);
      if (before.isSymbolicLink()) {
        hash.update(await readlink(absolute, { encoding: 'buffer' }));
        const after = await lstat(absolute, { bigint: true });
        if (
          before.ino !== after.ino ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          stale();
      } else {
        const handle = await this.#open(context, path);
        try {
          const initial = await handle.stat({ bigint: true });
          for await (const chunk of handle.createReadStream({ autoClose: false })) {
            if (!(chunk instanceof Buffer))
              throw new OrviaError('INTERNAL', 'unexpected source stream encoding');
            hash.update(chunk);
          }
          const after = await handle.stat({ bigint: true });
          if (
            initial.size !== after.size ||
            initial.mtimeNs !== after.mtimeNs ||
            initial.ctimeNs !== after.ctimeNs
          )
            stale();
        } finally {
          await handle.close();
        }
      }
      return hash.digest('hex');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return digest('missing');
      throw error;
    }
  }

  async #pass(context: Context): Promise<CodeSnapshot> {
    const metadata = await this.#metadata(context);
    const files = [];
    for (const path of [...metadata.records.keys()].sort()) {
      files.push(
        Object.freeze({
          path,
          fingerprint: digest(
            JSON.stringify([
              metadata.records.get(path),
              await this.#contentFingerprint(context, path),
            ]),
          ),
        }),
      );
    }
    const after = await this.#metadata(context);
    if (
      metadata.head !== after.head ||
      metadata.index !== after.index ||
      metadata.tree !== after.tree ||
      JSON.stringify(metadata.untracked) !== JSON.stringify(after.untracked)
    )
      stale();
    return Object.freeze({
      head: metadata.head,
      fingerprint: digest(JSON.stringify([metadata.head, metadata.index, files])),
      files: Object.freeze(files),
    });
  }

  async snapshot(root: string): Promise<CodeSnapshot> {
    const context = await this.#context(root);
    const first = await this.#pass(context);
    sameSnapshot(first, await this.#pass(context));
    return first;
  }

  async readSource(
    root: string,
    path: string,
    offset: number,
    maxBytes: number,
    expected?: string,
  ): Promise<SourcePage> {
    const before = await this.snapshot(root);
    expectSnapshot(before, expected);
    const context = await this.#context(root);
    let handle: FileHandle;
    try {
      const canonical = await realpath(await this.#path(context, path, true));
      if (!before.files.some((file) => resolve(context.root, file.path) === canonical)) {
        throw new OrviaError('NOT_FOUND', 'source file is not part of the observed code state', {
          path,
        });
      }
      handle = await this.#open(context, path);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new OrviaError('NOT_FOUND', 'source file does not exist', { path });
      }
      throw error;
    }
    let bytes: Buffer;
    let totalBytes: number;
    try {
      const initial = await handle.stat({ bigint: true });
      totalBytes = Number(initial.size);
      if (offset > totalBytes)
        throw new OrviaError('VALIDATION_FAILED', 'source offset exceeds file size');
      bytes = Buffer.alloc(Math.min(maxBytes, totalBytes - offset));
      let received = 0;
      while (received < bytes.length) {
        const read = await handle.read(bytes, received, bytes.length - received, offset + received);
        if (read.bytesRead === 0) stale();
        received += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (
        initial.size !== after.size ||
        initial.mtimeNs !== after.mtimeNs ||
        initial.ctimeNs !== after.ctimeNs
      )
        stale();
    } finally {
      await handle.close();
    }
    sameSnapshot(before, await this.snapshot(root));
    const next = offset + bytes.length;
    return {
      path,
      offset,
      nextOffset: next < totalBytes ? next : null,
      totalBytes,
      content: bytes.toString('base64'),
      encoding: 'base64',
      head: before.head,
      fingerprint: before.fingerprint,
      observedAt: new Date().toISOString(),
      complete: offset === 0 && next === totalBytes,
    };
  }

  async readChanges(
    root: string,
    baseCommit: string,
    maxBytes: number,
    expected?: string,
  ): Promise<WorkspaceChanges> {
    const before = await this.snapshot(root);
    expectSnapshot(before, expected);
    const resolved = (
      await this.#command(root, [
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${baseCommit}^{commit}`,
      ])
    ).trim();
    const names = nulRecords(
      await this.#command(root, ['diff', '--name-status', '--no-renames', '-z', resolved, '--']),
    );
    const allFiles: { path: string; status: string }[] = [];
    for (let index = 0; index < names.length; index += 2) {
      const status = names[index];
      const path = names[index + 1];
      if (status === undefined || path === undefined)
        throw new OrviaError('VALIDATION_FAILED', 'incomplete changed-file listing');
      allFiles.push({ path, status });
    }
    const stagedNames = nulRecords(
      await this.#command(root, [
        'diff',
        '--cached',
        '--name-status',
        '--no-renames',
        '-z',
        before.head,
        '--',
      ]),
    );
    for (let index = 0; index < stagedNames.length; index += 2) {
      const status = stagedNames[index];
      const path = stagedNames[index + 1];
      if (status === undefined || path === undefined)
        throw new OrviaError('VALIDATION_FAILED', 'incomplete staged-file listing');
      if (!allFiles.some((file) => file.path === path))
        allFiles.push({ path, status: `${status} (staged)` });
    }
    const untracked = nulRecords(
      await this.#command(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    );
    for (const path of untracked) allFiles.push({ path, status: '??' });
    allFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    let remaining = maxBytes;
    let complete = true;
    const files = [];
    for (const file of allFiles) {
      const size = Buffer.byteLength(JSON.stringify(file));
      if (size > remaining) {
        complete = false;
        break;
      }
      files.push(file);
      remaining -= size;
    }
    const tracked =
      remaining > 0
        ? await this.#git.run(
            root,
            ['diff', '--no-color', '--no-ext-diff', '--no-textconv', resolved, '--'],
            remaining,
          )
        : null;
    if (tracked !== null && tracked.exitCode !== 0)
      throw new OrviaError('VALIDATION_FAILED', 'git diff failed');
    let diff = tracked?.stdout ?? '';
    complete &&= tracked !== null && !tracked.truncated && !/^Binary files /m.test(diff);
    remaining -= Buffer.byteLength(diff);
    if (stagedNames.length > 0) {
      const heading = '\n# Staged changes relative to HEAD\n';
      remaining -= Buffer.byteLength(heading);
      if (remaining <= 0) complete = false;
      else {
        const staged = await this.#git.run(
          root,
          ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', before.head, '--'],
          remaining,
        );
        if (staged.exitCode !== 0)
          throw new OrviaError('VALIDATION_FAILED', 'staged git diff failed');
        diff += heading + staged.stdout;
        remaining -= Buffer.byteLength(staged.stdout);
        complete &&= !staged.truncated && !/^Binary files /m.test(staged.stdout);
      }
    }
    const context = await this.#context(root);
    for (const path of untracked) {
      if (remaining <= 0) {
        complete = false;
        break;
      }
      const absolute = await this.#path(context, path, false);
      const info = await lstat(absolute);
      let content: Buffer;
      if (info.isSymbolicLink()) {
        content = await readlink(absolute, { encoding: 'buffer' });
      } else {
        const handle = await this.#open(context, path);
        try {
          if ((await handle.stat()).size > remaining) {
            complete = false;
            continue;
          }
          const buffer = Buffer.alloc(remaining + 1);
          let received = 0;
          while (received < buffer.length) {
            const read = await handle.read(buffer, received, buffer.length - received, received);
            if (read.bytesRead === 0) break;
            received += read.bytesRead;
          }
          if (received > remaining) {
            complete = false;
            continue;
          }
          content = buffer.subarray(0, received);
        } finally {
          await handle.close();
        }
      }
      const text = content.toString('utf8');
      if (content.includes(0) || !Buffer.from(text).equals(content)) {
        complete = false;
        continue;
      }
      const lines = text === '' ? [] : text.split('\n');
      const hasNewline = text.endsWith('\n');
      if (hasNewline) lines.pop();
      const mode = info.isSymbolicLink()
        ? '120000'
        : (info.mode & 0o111) === 0
          ? '100644'
          : '100755';
      const oldPath = JSON.stringify(`a/${path}`);
      const newPath = JSON.stringify(`b/${path}`);
      const hunk =
        lines.length === 0
          ? ''
          : `--- /dev/null\n+++ ${newPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${hasNewline ? '' : '\\ No newline at end of file\n'}`;
      const patch = `diff --git ${oldPath} ${newPath}\nnew file mode ${mode}\n${hunk}`;
      if (Buffer.byteLength(patch) > remaining) {
        complete = false;
        continue;
      }
      diff += patch;
      remaining -= Buffer.byteLength(patch);
    }
    sameSnapshot(before, await this.snapshot(root));
    return {
      baseCommit: resolved,
      head: before.head,
      fingerprint: before.fingerprint,
      observedAt: new Date().toISOString(),
      files,
      diff,
      complete,
    };
  }
}
