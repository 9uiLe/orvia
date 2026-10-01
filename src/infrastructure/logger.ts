import type { LogFields, Logger, LogLevel } from '../application/ports.ts';

const ORDER: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

/** JSON lines on stderr. Persisting or rotating them is left to the process supervisor. */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = ORDER.indexOf(level);
  const log =
    (at: LogLevel) =>
    (message: string, fields: LogFields = {}) => {
      if (ORDER.indexOf(at) > threshold) return;
      write(
        JSON.stringify({ time: new Date().toISOString(), level: at, msg: message, ...fields }) +
          '\n',
      );
    };
  return {
    error: log('error'),
    warn: log('warn'),
    info: log('info'),
    debug: log('debug'),
    trace: log('trace'),
  };
}
