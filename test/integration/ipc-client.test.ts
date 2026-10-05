import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { IpcClient } from '../../src/interface/ipc-client.ts';
import { rejectsWith } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';

describe('IPC response contract', () => {
  let env: TestEnv;
  let closeServer: (() => Promise<void>) | null;
  beforeEach(() => {
    env = makeTestEnv();
    closeServer = null;
    mkdirSync(env.paths.runtimeDir, { recursive: true });
  });
  afterEach(async () => {
    await closeServer?.();
    env.cleanup();
  });
  async function respond(send: (response: ServerResponse) => void): Promise<IpcClient> {
    const server = createServer((_request, response) => {
      send(response);
    });
    await new Promise<void>((resolve) => {
      server.listen(env.paths.socketPath, resolve);
    });
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeAllConnections();
      });
    return new IpcClient(env.paths.socketPath);
  }

  for (const body of ['not JSON', 'null', '{"ok":false}', '{"ok":"true","result":1}']) {
    test(`invalid response ${body} rejects through the client error contract`, async () => {
      const client = await respond((response) => {
        response.end(body);
      });
      const error = await rejectsWith(client.call('get_status', {}), 'INTERNAL');
      assert.match(error.message, /invalid response/);
    });
  }

  test('a response interrupted after its headers rejects instead of leaving the call pending', async () => {
    const client = await respond((response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': 100,
        connection: 'close',
      });
      response.write('{"ok":true');
      response.end();
    });
    await rejectsWith(client.call('get_status', {}), 'INTERNAL');
  });
});
