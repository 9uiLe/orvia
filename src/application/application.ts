import type { Dependencies } from './dependencies.ts';
import { RunSupervisor } from './runs.ts';
import { StorageService } from './storage.ts';

export class Application {
  readonly deps: Dependencies;
  readonly storage: StorageService;
  readonly runs: RunSupervisor;

  constructor(deps: Dependencies) {
    this.deps = deps;
    this.storage = new StorageService(deps);
    this.runs = new RunSupervisor(deps, this.storage);
  }

  scheduleCleanupIfNeeded(): void {
    this.storage.cleanupIfNeeded().catch((error: unknown) => {
      this.deps.logger.error('storage cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
