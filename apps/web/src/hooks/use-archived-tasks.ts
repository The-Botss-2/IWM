'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApi } from '@/lib/api';
import { invalidateDashboardTaskWidgets, removeEverywhere, restore } from './tasks/query-helpers';

const archivedTasksKey = (projectId: string) => ['archived-tasks', projectId] as const;

export function useArchivedTasks(projectId: string) {
  return useQuery({
    queryKey: archivedTasksKey(projectId),
    queryFn: () => getApi().tasks.archived(projectId),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Archive (a soft delete) like useDeleteTask: the task leaves every cached
 * list at once and comes back on error. No `['tasks']` invalidation (feedback
 * §4, the kanban reorder loop): the board and list read those caches. Only
 * the project's archived list - a read-only view nobody edits - and the
 * dashboard widgets are refreshed.
 */
export function useArchiveTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().tasks.archive(id),
    meta: { successMessage: 'Task archived.', errorTitle: "Couldn't archive task" },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      return { pages: removeEverywhere(qc, id) };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: archivedTasksKey(projectId) });
      invalidateDashboardTaskWidgets(qc);
    },
  });
}

export function useRestoreTask(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().tasks.restore(id),
    meta: { successMessage: 'Task restored.', errorTitle: "Couldn't restore task" },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: archivedTasksKey(projectId) });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
