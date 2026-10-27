/**
 * `GET /tasks` filter self-checks (no database): the query schema accepts the
 * dashboard's date-range / unassigned params as they arrive on the wire, the
 * pure where-builder composes them with AND (status, priority, assignees and
 * dates never overwrite each other), the legacy params keep their meaning, and
 * `TasksService.list` keeps the access scope next to the new clauses.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { listTasksQuerySchema, type ListTasksQuery } from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { buildTaskListFilters } from '../tasks/task-list-filters';
import { TasksService } from '../tasks/tasks.service';

const ME = 'cme0000000000000000000001';
const ALICE = 'cma0000000000000000000001';
const BOB = 'cmb0000000000000000000001';

function parse(raw: Record<string, unknown>): ListTasksQuery {
  return listTasksQuerySchema.parse(raw);
}

function clauses(raw: Record<string, unknown>) {
  return buildTaskListFilters(parse(raw), ME);
}

async function main(): Promise<void> {
  // --- schema ---------------------------------------------------------------
  const q = parse({
    dateField: 'completed',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-10-31T23:59:59.999Z',
    unassigned: 'true',
    noDueDate: 'false',
  });
  assert.equal(q.dateField, 'completed');
  assert.ok(q.from instanceof Date && q.to instanceof Date);
  assert.equal(q.to.toISOString(), '2026-10-31T23:59:59.999Z');
  assert.equal(q.unassigned, true);
  assert.equal(q.noDueDate, false);
  assert.equal(listTasksQuerySchema.safeParse({ dateField: 'started' }).success, false);
  assert.equal(
    listTasksQuerySchema.safeParse({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })
      .success,
    false,
    'from after to is rejected',
  );
  assert.equal(listTasksQuerySchema.safeParse({ unassigned: 'yes' }).success, false);

  // --- no filters -> no clauses ---------------------------------------------
  assert.deepEqual(clauses({}), []);

  // --- legacy params unchanged ----------------------------------------------
  assert.deepEqual(clauses({ status: 'DONE' }), [{ status: 'DONE' }]);
  assert.deepEqual(clauses({ status: ['TODO', 'DONE'] }), [{ status: { in: ['TODO', 'DONE'] } }]);
  assert.deepEqual(clauses({ assigneeId: ALICE }), [{ assigneeId: ALICE }]);
  assert.deepEqual(clauses({ assigneeIds: [ALICE, BOB] }), [{ assigneeId: { in: [ALICE, BOB] } }]);
  assert.deepEqual(
    clauses({ assigneeIds: [ALICE], assignedToMe: 'true' }),
    [{ assigneeId: ME }],
    'assignedToMe still overrides the assignee list',
  );
  const due = clauses({ dueAfter: '2026-10-01T00:00:00Z', dueBefore: '2026-10-08T00:00:00Z' });
  assert.deepEqual(due, [
    { dueDate: { gte: new Date('2026-10-01T00:00:00Z'), lte: new Date('2026-10-08T00:00:00Z') } },
  ]);

  // --- unassigned -------------------------------------------------------------
  assert.deepEqual(clauses({ unassigned: 'true' }), [{ assigneeId: null }]);
  assert.deepEqual(clauses({ unassigned: 'true', assigneeIds: [ALICE, BOB] }), [
    { OR: [{ assigneeId: { in: [ALICE, BOB] } }, { assigneeId: null }] },
  ]);
  assert.deepEqual(clauses({ unassigned: 'false', assigneeIds: ALICE }), [{ assigneeId: ALICE }]);
  assert.deepEqual(clauses({ noDueDate: 'true' }), [{ dueDate: null }]);

  // --- generic date range -----------------------------------------------------
  const from = new Date('2026-10-01T00:00:00.000Z');
  const to = new Date('2026-10-31T23:59:59.999Z');
  const iso = { from: from.toISOString(), to: to.toISOString() };
  assert.deepEqual(clauses(iso), [{ dueDate: { gte: from, lte: to } }], 'dateField defaults to due');
  assert.deepEqual(clauses({ ...iso, dateField: 'created' }), [{ createdAt: { gte: from, lte: to } }]);
  assert.deepEqual(clauses({ ...iso, dateField: 'completed' }), [
    {
      OR: [
        { completedAt: { gte: from, lte: to } },
        { completedAt: null, status: 'DONE', updatedAt: { gte: from, lte: to } },
      ],
    },
  ]);
  assert.deepEqual(clauses({ from: iso.from, dateField: 'created' }), [{ createdAt: { gte: from } }]);
  assert.deepEqual(clauses({ to: iso.to }), [{ dueDate: { lte: to } }]);

  // --- everything composes with AND, nothing overwritten ----------------------
  const all = clauses({
    projectId: 'cmp0000000000000000000001',
    status: ['TODO', 'IN_PROGRESS'],
    priority: 'HIGH',
    assigneeIds: [ALICE],
    unassigned: 'true',
    ...iso,
    dateField: 'completed',
    dueAfter: '2026-09-01T00:00:00Z',
    search: 'invoice',
  });
  assert.equal(all.length, 7);
  const ors = all.filter((c) => 'OR' in c);
  assert.equal(ors.length, 3, 'assignee, completed range and search each keep their own OR');

  // --- service keeps the access scope and attaches the clauses ----------------
  const captured: Array<Record<string, unknown>> = [];
  const prisma = {
    client: {
      task: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          captured.push(args.where);
          return [];
        },
        count: async () => 0,
      },
    },
  };
  // The service only touches prisma.client.task here; the other collaborators
  // are unused by `list`.
  const service = new TasksService(
    prisma as never,
    {} as never,
    {} as never,
  );
  const scope: UserScope = {
    userId: ME,
    workspaceIds: ['cmw0000000000000000000001'],
    projectIds: [],
    currentWorkspaceId: 'cmw0000000000000000000001',
    workspaceRole: 'MEMBER',
    seesEveryProject: true,
  };
  await service.list(scope, parse({ unassigned: 'true', ...iso }));
  assert.deepEqual(captured[0], {
    project: { workspaceId: { in: ['cmw0000000000000000000001'] } },
    AND: [{ assigneeId: null }, { dueDate: { gte: from, lte: to } }],
  });
  await service.list(scope, parse({}));
  assert.deepEqual(captured[1], { project: { workspaceId: { in: ['cmw0000000000000000000001'] } } });

  console.log('task list filter checks passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
