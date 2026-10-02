import type { StorageLimits } from '../domain/storage.ts';
import type { AgentProfile } from './agent-profiles.ts';
import type {
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
  readonly profiles: ReadonlyMap<string, AgentProfile>;
  readonly launcher: ProcessLauncher;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limits: StorageLimits;
  readonly orchestration: {
    readonly maxAutoFixRounds: number;
    /** Used by start_cycle when the request names no profile; never guessed otherwise. */
    readonly defaultImplementationProfile: string | null;
    readonly defaultReviewProfile: string | null;
    readonly maxReviewDiffBytes: number;
  };
}

export function nowIso(deps: Pick<Dependencies, 'clock'>): string {
  return deps.clock.now().toISOString();
}
