import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openDatabase } from '../../src/infrastructure/sqlite/database.ts';
import { MIGRATIONS } from '../../src/infrastructure/sqlite/migrations/index.ts';
import {
  READ_QUERIES,
  WRITE_STATEMENTS,
  type ReadQueryName,
} from '../../src/infrastructure/sqlite/queries.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';
import { mkdirSync } from 'node:fs';

const PARAMS: Record<ReadQueryName, SQLInputValue[]> = {
  getPlan: [1],
  listPlansByStatus: ['active'],
  countPlansByStatus: [],
  getWorkItem: [1],
  listWorkItemsForPlan: [1],
  listWorkItemsForPlanByStatus: [1, '["active","paused"]'],
  listWorkItemsByStatus: ['["active","paused"]'],
  countWorkItemsByStatus: [],
  getRun: [1],
  getCurrentRun: [1],
  listRunsForWorkItem: [1],
  listRunningRuns: [],
  getDecision: [1],
  listDecisionsForPlan: [1],
  getNote: [1],
  listNotesForPlan: [1],
};

/**
 * Every read query must reach its rows through an index or the rowid. A plain "SCAN <table>"
 * means a full table scan, which grows with the number of Plans and Work Items.
 */
describe('query plans', () => {
  let env: TestEnv;
  let db: DatabaseSync;

  before(() => {
    env = makeTestEnv();
    mkdirSync(env.paths.dataDir, { recursive: true });
    db = openDatabase({
      path: env.paths.databaseFile,
      backupDir: env.paths.backupDir,
      migrations: MIGRATIONS,
      now: () => new Date(),
      databaseMaxBytes: 128 * 1024 * 1024,
    }).db;
    db.exec('ANALYZE');
  });
  after(() => {
    db.close();
    env.cleanup();
  });

  for (const name of Object.keys(READ_QUERIES) as ReadQueryName[]) {
    test(name, () => {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${READ_QUERIES[name]}`)
        .all(...PARAMS[name])
        .map((row) => String(row['detail']));
      const fullScans = plan.filter(
        (detail) =>
          detail.startsWith('SCAN ') &&
          !detail.includes(' USING ') &&
          !detail.includes('VIRTUAL TABLE'),
      );
      assert.deepEqual(fullScans, [], `${name}:\n${plan.join('\n')}`);
    });
  }

  // Sorting a Work Item list, the running runs, or a Work Item's runs uses a temporary b-tree. Its size is bounded
  // by those rows, and temp_store = MEMORY keeps it off disk. Adding indexes to avoid these
  // sorts was not worth a migration; a new query that sorts should be a conscious choice.
  test('only the known, bounded sorts use temporary b-trees', () => {
    const queries: [string, string, SQLInputValue[]][] = [
      ...(Object.keys(READ_QUERIES) as ReadQueryName[]).map(
        (name): [string, string, SQLInputValue[]] => [name, READ_QUERIES[name], PARAMS[name]],
      ),
      ['finishedRunsBeyondKeep', WRITE_STATEMENTS.finishedRunsBeyondKeep, [5]],
    ];
    const sorting = queries
      .filter(([, sql, params]) =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...params)
          .some((row) => String(row['detail']).includes('TEMP B-TREE')),
      )
      .map(([name]) => name);
    assert.deepEqual(sorting, [
      'listWorkItemsForPlan',
      'listWorkItemsForPlanByStatus',
      'listWorkItemsByStatus',
      'listRunningRuns',
      'finishedRunsBeyondKeep',
    ]);
  });
});
