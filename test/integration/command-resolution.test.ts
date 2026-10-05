import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NodeProcessLauncher } from '../../src/infrastructure/agents/process-launcher.ts';
import { makeTestEnv } from '../helpers/env.ts';

test('command resolution accepts executable files and symlinks, and refuses directories', async () => {
  const env = makeTestEnv();
  const launcher = new NodeProcessLauncher({ graceMs: 10, killConfirmationMs: 10 });
  try {
    const executable = join(env.root, 'agent');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const linked = join(env.root, 'agent-link');
    symlinkSync(executable, linked);
    const directory = join(env.root, 'agent-directory');
    mkdirSync(directory, { mode: 0o700 });
    assert.equal(await launcher.resolveCommand(executable), executable);
    assert.equal(await launcher.resolveCommand(linked), linked);
    assert.equal(await launcher.resolveCommand(directory), null);
    chmodSync(executable, 0o600);
    assert.equal(await launcher.resolveCommand(executable), null);
    assert.equal(await launcher.resolveCommand(join(env.root, 'missing')), null);
  } finally {
    env.cleanup();
  }
});
