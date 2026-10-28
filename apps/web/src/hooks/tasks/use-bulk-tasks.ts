'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BulkTaskRequest, TaskWithPeople } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';
import {
  findCachedUser,
  invalidateDashboardTaskWidgets,
  restore,
  snapshotPages,
  type TaskListPage,
} from './query-helpers';

/**
 * Bulk-mutate multiple tasks at once (Board/List multi-select). The cache is
 * patched optimistically by `kind` so the action feels instant; on error the
 * snapshotted pages are restored and a toast is surfaced.
 */
export function useBulkTasks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkTaskRequest) => getApi().tasks.bulk(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const idSet = new Set(input.ids);
      const op = input.operation;
      let pages: ReturnType<typeof snapshotPages>;
      if (op.kind === 'delete') {
        pages = snapshotPages(qc);
        for (const [key, data] of pages) {
          if (!data?.items) continue;
          qc.setQueryData<TaskListPage>(key, {
            ...data,
            items: data.items.filter((t) => !idSet.has(t.id)),
          });
        }
      } else {
        pages = snapshotPages(qc);
        for (const [key, data] of pages) {
          if (!data?.items) continue;
          qc.setQueryData<TaskListPage>(key, {
            ...data,
            items: data.items.map((t) => {
              if (!idSet.has(t.id)) return t;
              const next: TaskWithPeople = { ...t, updatedAt: new Date() };
              if (op.kind === 'status') {
                next.status = op.status;
                if (op.status === 'DONE' && t.status !== 'DONE') {
                  next.completedAt = new Date();
                } else if (op.status !== 'DONE' && t.status === 'DONE') {
                  next.completedAt = null;
                }
              } else if (op.kind === 'priority') {
                next.priority = op.priority;
              } else if (op.kind === 'assignee') {
                next.assigneeId = op.assigneeId ?? null;
                next.assignee =
                  op.assigneeId == null
                    ? null
                    : (findCachedUser(qc, op.assigneeId) ?? next.assignee);
              }
              return next;
            }),
          });
        }
      }
      return { pages };
    },
    // No onSuccess invalidation - every patched/deleted row is already merged
    // into the cache pages above; invalidating would refetch into the active
    // multi-select selection and re-trigger the kanban reorder loop. Only
    // the dashboard's derived widget queries are refreshed.
    onSuccess: () => invalidateDashboardTaskWidgets(qc),
    onError: (err, _input, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't apply bulk action");
    },
  });
}
