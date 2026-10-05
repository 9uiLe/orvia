import { CycleSupervisor } from './cycles.ts';
import { CheckpointSupervisor } from './checkpoints.ts';
import type { Dependencies } from './dependencies.ts';
import { RunSupervisor } from './runs.ts';
import { StorageService } from './storage.ts';

export class Application {
  readonly deps: Dependencies;
  readonly storage: StorageService;
  readonly runs: RunSupervisor;
  readonly cycles: CycleSupervisor;
  readonly checkpoints: CheckpointSupervisor;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.storage = new StorageService(deps, () => this.runs.recordingRunIds());
    this.runs = new RunSupervisor(deps, this.storage);
    this.cycles = new CycleSupervisor(deps, this.runs, this.storage);
    this.checkpoints = new CheckpointSupervisor(deps, this.runs);
  }

  scheduleCleanupIfNeeded(): void {
    this.storage.cleanupIfNeeded().catch((error: unknown) => {
      this.deps.logger.error('storage cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
