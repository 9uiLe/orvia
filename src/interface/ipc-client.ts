import { request } from 'node:http';
import { OrviaError } from '../domain/errors.ts';
import {
  HEALTH_PATH,
  OPERATION_PATH_PREFIX,
  type HealthInfo,
  type WireResponse,
  decodeWireResponse,
} from './ipc-protocol.ts';

/** Talks to the daemon over its local socket. Clients never open the database themselves. */
export class IpcClient {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  call(operation: string, input: unknown): Promise<unknown> {
    return this.#send('POST', OPERATION_PATH_PREFIX + encodeURIComponent(operation), input);
  }

  async health(): Promise<HealthInfo> {
    return (await this.#send('GET', HEALTH_PATH, undefined)) as HealthInfo;
  }

  #send(method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.#socketPath,
          path,
          method,
          headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', () => {
            reject(new OrviaError('INTERNAL', 'daemon response was interrupted'));
          });
          res.on('end', () => {
            let parsed: WireResponse;
            try {
              parsed = decodeWireResponse(Buffer.concat(chunks).toString('utf8'));
            } catch (error) {
              reject(
                error instanceof Error
                  ? error
                  : new OrviaError('INTERNAL', 'daemon returned an invalid response'),
              );
              return;
            }
            if (parsed.ok) resolve(parsed.result);
            else
              reject(new OrviaError(parsed.error.code, parsed.error.message, parsed.error.details));
          });
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          reject(
            new OrviaError(
              'DAEMON_NOT_RUNNING',
              'the orvia daemon is not running; start it with `orvia daemon`',
              {
                socketPath: this.#socketPath,
              },
            ),
          );
          return;
        }
        reject(error);
      });
      req.end(payload);
    });
  }
}
