import { chmodSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Application } from '../../application/application.ts';
import { invokeOperation } from '../../application/operations.ts';
import { OrviaError, isOrviaError } from '../../domain/errors.ts';
import { ORVIA_VERSION } from '../../version.ts';
import {
  HEALTH_PATH,
  OPERATION_PATH_PREFIX,
  type HealthInfo,
  type WireError,
  type WireResponse,
} from '../ipc-protocol.ts';

function toWireError(error: unknown): WireError {
  if (isOrviaError(error))
    return { code: error.code, message: error.message, details: error.details };
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
}

function send(res: ServerResponse, status: number, body: WireResponse): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OrviaError('VALIDATION_FAILED', 'request body is not valid JSON');
  }
}

/** Resolves true when something is already accepting connections on the socket path. */
function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

export async function startIpcServer(app: Application, socketPath: string): Promise<Server> {
  const health = (): HealthInfo => ({
    version: ORVIA_VERSION,
    pid: process.pid,
    schemaVersion: app.deps.store.maintenance.schemaStatus().databaseVersion,
  });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? '';
        if (req.method === 'GET' && url === HEALTH_PATH) {
          send(res, 200, { ok: true, result: health() });
          return;
        }
        if (req.method === 'POST' && url.startsWith(OPERATION_PATH_PREFIX)) {
          const name = decodeURIComponent(url.slice(OPERATION_PATH_PREFIX.length));
          const result = await invokeOperation(app, name, await readJson(req));
          send(res, 200, { ok: true, result: result ?? null });
          return;
        }
        send(res, 404, {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: `no route for ${req.method ?? ''} ${url}`,
            details: {},
          },
        });
      } catch (error) {
        const wire = toWireError(error);
        if (wire.code === 'INTERNAL') {
          app.deps.logger.error('operation failed', { message: wire.message });
        }
        send(res, 200, { ok: false, error: wire });
      }
    })();
  });

  if (process.platform !== 'win32') {
    if (await isListening(socketPath)) {
      throw new OrviaError(
        'DAEMON_ALREADY_RUNNING',
        `another orvia daemon is listening on ${socketPath}`,
        { socketPath },
      );
    }
    // A socket file left by a daemon that crashed; nothing is listening on it.
    rmSync(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
  return server;
}
