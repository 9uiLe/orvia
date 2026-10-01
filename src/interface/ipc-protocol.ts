import type { ErrorDetails, OrviaErrorCode } from '../domain/errors.ts';

/** Local control API between the daemon and its clients (CLI, MCP server). Not a public API. */
export const OPERATION_PATH_PREFIX = '/v1/operations/';
export const HEALTH_PATH = '/v1/health';

export interface WireError {
  readonly code: OrviaErrorCode;
  readonly message: string;
  readonly details: ErrorDetails;
}

export type WireResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: WireError };

export interface HealthInfo {
  readonly version: string;
  readonly pid: number;
  readonly schemaVersion: number;
}
