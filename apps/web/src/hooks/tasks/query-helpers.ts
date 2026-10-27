'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { ListTasksQuery, TaskWithPeople } from '@botss/shared-types';

export { findCachedUser } from '@/lib/member-cache';

export const tasksKey = (q?: Partial<ListTasksQuery>) => ['tasks', q ?? {}] as const;

export type TaskListPage = { items: TaskWithPeople[] } & Record<string, unknown>;

/**
 * Dashboard widgets that derive numbers from task lists under their own
 * (non-`tasks`) keys. Task mutations deliberately skip invalidating
 * `['tasks']` (see the kanban reorder-loop notes on each mutation hook), so
 * without this the dashboard would show stale counts for up to its stale
 * time after a task is created, edited or deleted. Invalidating these keys
 * is safe: they never back the board/list views, and only mounted (active)
 * widgets refetch - everything else is just marked stale.
 */
const DASHBOARD_TASK_WIDGET_KEYS: ReadonlyArray<readonly string[]> = [
  ['ws-done-tasks'],
  ['ws-task-snapshot'],
  ['ws-kpi', 'overdue'],
  ['ws-upcoming'],
  ['ws-recent-by-user'],
  ['ws-sprint-tasks'],
];

export function invalidateDashboardTaskWidgets(qc: ReturnType<typeof useQueryClient>): void {
  for (const queryKey of DASHBOARD_TASK_WIDGET_KEYS) {
    void qc.invalidateQueries({ queryKey });
  }
}

export function snapshotPages(qc: ReturnType<typeof useQueryClient>) {
  return qc.getQueriesData<TaskListPage>({ queryKey: ['tasks'] });
}

export function patchEvery(
  qc: ReturnType<typeof useQueryClient>,
  taskId: string,
  patch: (t: TaskWithPeople) => TaskWithPeople,
) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    qc.setQueryData<TaskListPage>(key, {
      ...data,
      items: data.items.map((t) => (t.id === taskId ? patch(t) : t)),
    });
  }
  return pages;
}

export function removeEverywhere(qc: ReturnType<typeof useQueryClient>, taskId: string) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    qc.setQueryData<TaskListPage>(key, {
      ...data,
      items: data.items.filter((t) => t.id !== taskId),
    });
  }
  return pages;
}

export function restore(
  qc: ReturnType<typeof useQueryClient>,
  pages: ReturnType<typeof snapshotPages>,
) {
  for (const [key, data] of pages) qc.setQueryData(key, data);
}
