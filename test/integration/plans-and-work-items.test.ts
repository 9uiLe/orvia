import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Plan } from '../../src/domain/plan.ts';
import type { Decision } from '../../src/domain/records.ts';
import type { WorkItem } from '../../src/domain/work-item.ts';
import type { Daemon } from '../../src/interface/daemon/daemon.ts';
import { call, rejectsWith, startTestDaemon } from '../helpers/app.ts';
import { makeTestEnv, type TestEnv } from '../helpers/env.ts';

describe('plans and work items', () => {
  let env: TestEnv;
  let daemon: Daemon;

  beforeEach(async () => {
    env = makeTestEnv();
    daemon = await startTestDaemon(env);
  });
  afterEach(async () => {
    await daemon.close();
    env.cleanup();
  });

  const createItem = (title: string, extra: Record<string, unknown> = {}) =>
    call<WorkItem>(daemon.app, 'create_work_item', { planId: 'P-1', title, ...extra });

  test('plan create, read, update, list, archive', async () => {
    const plan = await call<Plan>(daemon.app, 'create_plan', { title: 'KMP rollout' });
    assert.equal(plan.id, 'P-1');
    const updated = await call<Plan>(daemon.app, 'update_plan', {
      planId: 'P-1',
      description: 'Share the data layer',
    });
    assert.equal(updated.title, 'KMP rollout');
    assert.equal(updated.description, 'Share the data layer');
    assert.deepEqual(
      (await call<Plan[]>(daemon.app, 'list_plans')).map((p) => p.id),
      ['P-1'],
    );

    const item = await createItem('W');
    await rejectsWith(
      call(daemon.app, 'archive_plan', { planId: 'P-1' }),
      'INVALID_STATE_TRANSITION',
    );
    await call(daemon.app, 'archive_work_item', { workItemId: item.id });
    const archived = await call<Plan>(daemon.app, 'archive_plan', { planId: 'P-1' });
    assert.equal(archived.status, 'archived');
    assert.deepEqual(await call<Plan[]>(daemon.app, 'list_plans'), []);
    assert.equal((await call<Plan[]>(daemon.app, 'list_plans', { status: 'archived' })).length, 1);
    await rejectsWith(
      call(daemon.app, 'update_plan', { planId: 'P-1', title: 'x' }),
      'INVALID_STATE_TRANSITION',
    );
    await rejectsWith(createItem('late'), 'INVALID_STATE_TRANSITION');
  });

  test('a plan is split into several work items without changing the plan', async () => {
    await call(daemon.app, 'create_plan', { title: 'KMP rollout' });
    const original = await createItem('Everything');
    const parts = [];
    for (const title of ['Repository changes', 'UI changes', 'Legacy cleanup']) {
      parts.push(await createItem(title, { splitFromWorkItemId: original.id }));
    }
    await call(daemon.app, 'archive_work_item', { workItemId: original.id });

    const details = await call<{ plan: Plan; workItems: WorkItem[] }>(daemon.app, 'get_plan', {
      planId: 'P-1',
    });
    assert.equal(details.plan.id, 'P-1');
    assert.deepEqual(
      details.workItems.filter((w) => w.status === 'active').map((w) => [w.title, w.splitFromId]),
      parts.map((p) => [p.title, original.id]),
    );
    const open = await call<WorkItem[]>(daemon.app, 'list_work_items', { planId: 'P-1' });
    assert.equal(open.length, 3);
  });

  test('split lineage must stay within the plan', async () => {
    await call(daemon.app, 'create_plan', { title: 'A' });
    await call(daemon.app, 'create_plan', { title: 'B' });
    const inA = await createItem('a');
    await rejectsWith(
      call(daemon.app, 'create_work_item', {
        planId: 'P-2',
        title: 'b',
        splitFromWorkItemId: inA.id,
      }),
      'VALIDATION_FAILED',
    );
  });

  test('work item update records the PR mapping', async () => {
    await call(daemon.app, 'create_plan', { title: 'P' });
    const item = await createItem('W');
    const withPr = await call<WorkItem>(daemon.app, 'update_work_item', {
      workItemId: item.id,
      prUrl: 'https://github.com/example/app/pull/7',
    });
    assert.equal(withPr.prUrl, 'https://github.com/example/app/pull/7');
    const cleared = await call<WorkItem>(daemon.app, 'update_work_item', {
      workItemId: item.id,
      prUrl: null,
    });
    assert.equal(cleared.prUrl, null);
    await rejectsWith(
      call(daemon.app, 'update_work_item', { workItemId: item.id, prUrl: 'not a url' }),
      'VALIDATION_FAILED',
    );
  });

  test('changing a decision keeps the old one as superseded', async () => {
    await call(daemon.app, 'create_plan', { title: 'P' });
    const first = await call<Decision>(daemon.app, 'record_decision', {
      planId: 'P-1',
      title: 'REST',
      body: 'simple',
    });
    const second = await call<Decision>(daemon.app, 'record_decision', {
      planId: 'P-1',
      title: 'gRPC',
      body: 'streaming',
      supersedesDecisionId: first.id,
    });
    const { decisions } = await call<{ decisions: Decision[] }>(daemon.app, 'get_plan', {
      planId: 'P-1',
    });
    assert.deepEqual(
      decisions.map((d) => [d.id, d.status, d.supersedesId]),
      [
        [first.id, 'superseded', null],
        [second.id, 'accepted', first.id],
      ],
    );
    await rejectsWith(
      call(daemon.app, 'record_decision', {
        planId: 'P-1',
        title: 'again',
        body: 'x',
        supersedesDecisionId: first.id,
      }),
      'INVALID_STATE_TRANSITION',
    );
  });
});
