import { OrviaError, type ErrorDetails, type OrviaErrorCode } from '../domain/errors.ts';

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

export function decodeWireResponse(text: string): WireResponse {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const value = parsed as Record<string, unknown>;
    if (value['ok'] === true && 'result' in value) return parsed as WireResponse;
    const error = value['error'];
    if (
      value['ok'] === false &&
      typeof error === 'object' &&
      error !== null &&
      !Array.isArray(error)
    ) {
      const fields = error as Record<string, unknown>;
      const details = fields['details'];
      if (
        typeof fields['code'] === 'string' &&
        typeof fields['message'] === 'string' &&
        typeof details === 'object' &&
        details !== null &&
        !Array.isArray(details)
      )
        return parsed as WireResponse;
    }
  } catch {
    throw new OrviaError('INTERNAL', 'daemon returned an invalid response');
  }
  throw new OrviaError('INTERNAL', 'daemon returned an invalid response');
}

export interface HealthInfo {
  readonly version: string;
  readonly pid: number;
  readonly schemaVersion: number;
}
