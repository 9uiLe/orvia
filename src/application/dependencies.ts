import type { StorageLimits } from '../domain/storage.ts';
import type {
  AgentAdapter,
  Clock,
  DatabaseFiles,
  EphemeralStore,
  GitInspector,
  Logger,
  ProcessLauncher,
  Store,
} from './ports.ts';

export interface Dependencies {
  readonly store: Store;
  readonly databaseFiles: DatabaseFiles;
  readonly cache: EphemeralStore;
  readonly git: GitInspector;
  readonly agents: ReadonlyMap<string, AgentAdapter>;
  readonly launcher: ProcessLauncher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limits: StorageLimits;
}

export function nowIso(deps: Pick<Dependencies, 'clock'>): string {
  return deps.clock.now().toISOString();
}
