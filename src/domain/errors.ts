export type OrviaErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'INVALID_STATE_TRANSITION'
  | 'WORKSPACE_MISMATCH'
  | 'WORKSPACE_CONFLICT'
  | 'WORKSPACE_NOT_BOUND'
  | 'RUN_IN_PROGRESS'
  | 'CYCLE_ACTIVE'
  | 'RECOVERY_INCOMPLETE'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_TERMINATION_FAILED'
  | 'STORAGE_HARD_LIMIT'
  | 'UNSUPPORTED_DATABASE_VERSION'
  | 'NOT_AN_ORVIA_DATABASE'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_STORAGE_REQUIRED'
  | 'DATABASE_INTEGRITY_FAILED'
  | 'DATABASE_LOCKED'
  | 'DAEMON_NOT_RUNNING'
  | 'DAEMON_ALREADY_RUNNING'
  | 'CONFIG_INVALID'
  | 'INTERNAL';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class OrviaError extends Error {
  readonly code: OrviaErrorCode;
  readonly details: ErrorDetails;

  constructor(code: OrviaErrorCode, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'OrviaError';
    this.code = code;
    this.details = details;
  }
}

export function isOrviaError(error: unknown): error is OrviaError {
  return error instanceof OrviaError;
}
