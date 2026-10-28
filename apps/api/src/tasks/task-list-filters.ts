import type { ListTasksQuery, TaskDateField } from '@botss/shared-types';

/**
 * Prisma `where` clauses for the user-chosen filters of `GET /tasks`. Pure so
 * `check-task-list-filters.ts` can pin the semantics without a database.
 *
 * Every clause is ANDed by the caller, so filters never overwrite each other
 * (the old code assigned `where.assigneeId` / `where.OR` directly). Access
 * scoping (which projects / workspaces the caller can read) is NOT built here:
 * it stays in `TasksService.list` and is applied alongside these clauses.
 */
export type TaskWhereClause = Record<string, unknown>;

const DATE_COLUMN: Record<Exclude<TaskDateField, 'completed'>, string> = {
  due: 'dueDate',
  created: 'createdAt',
};

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function range(from: Date | undefined, to: Date | undefined): { gte?: Date; lte?: Date } {
  const r: { gte?: Date; lte?: Date } = {};
  if (from) r.gte = from;
  if (to) r.lte = to;
  return r;
}

export function buildTaskListFilters(q: ListTasksQuery, userId: string): TaskWhereClause[] {
  const clauses: TaskWhereClause[] = [];

  if (q.projectId) clauses.push({ projectId: q.projectId });

  const status = asArray(q.status);
  if (status.length === 1) clauses.push({ status: status[0] });
  else if (status.length > 1) clauses.push({ status: { in: status } });

  const priority = asArray(q.priority);
  if (priority.length === 1) clauses.push({ priority: priority[0] });
  else if (priority.length > 1) clauses.push({ priority: { in: priority } });

  // Assignee. `assignedToMe` keeps its old meaning of overriding the rest.
  if (q.assignedToMe) {
    clauses.push({ assigneeId: userId });
  } else {
    const ids = asArray(q.assigneeIds ?? q.assigneeId);
    const idClause =
      ids.length === 0
        ? null
        : ids.length === 1
          ? { assigneeId: ids[0] }
          : { assigneeId: { in: ids } };
    if (idClause && q.unassigned) clauses.push({ OR: [idClause, { assigneeId: null }] });
    else if (idClause) clauses.push(idClause);
    else if (q.unassigned) clauses.push({ assigneeId: null });
  }

  // Legacy due bounds.
  if (q.dueBefore || q.dueAfter) clauses.push({ dueDate: range(q.dueAfter, q.dueBefore) });
  if (q.noDueDate) clauses.push({ dueDate: null });

  // Generic range on the chosen date column.
  if (q.from || q.to) {
    const r = range(q.from, q.to);
    const field = q.dateField ?? 'due';
    if (field === 'completed') {
      // Same rule the dashboard's completion widgets use: completedAt, else
      // updatedAt for DONE rows completed before completedAt was stamped.
      clauses.push({
        OR: [{ completedAt: r }, { completedAt: null, status: 'DONE', updatedAt: r }],
      });
    } else {
      clauses.push({ [DATE_COLUMN[field]]: r });
    }
  }

  if (q.search) {
    clauses.push({
      OR: [
        { title: { contains: q.search, mode: 'insensitive' } },
        { description: { contains: q.search, mode: 'insensitive' } },
      ],
    });
  }

  return clauses;
}
