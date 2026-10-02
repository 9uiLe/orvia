import type { Migration } from '../migrator.ts';
import { initial } from './0001_initial.ts';
import { orchestration } from './0002_orchestration.ts';

/** Append only. Never edit a migration that has been released; add a new one instead. */
export const MIGRATIONS: readonly Migration[] = [initial, orchestration];
