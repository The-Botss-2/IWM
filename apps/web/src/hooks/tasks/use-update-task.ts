'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TaskWithPeople, UpdateTaskInput } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';
import {
  findCachedUser,
  invalidateDashboardTaskWidgets,
  patchEvery,
  restore,
} from './query-helpers';

export function useUpdateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaskInput }) =>
      getApi().tasks.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const pages = patchEvery(qc, id, (t) => {
        const next: TaskWithPeople = { ...t };
        if (input.title !== undefined) next.title = input.title;
        if (input.description !== undefined) next.description = input.description;
        if (input.status !== undefined) next.status = input.status;
        if (input.priority !== undefined) next.priority = input.priority;
        if (input.dueDate !== undefined) next.dueDate = input.dueDate ?? null;
        if (input.startDate !== undefined) next.startDate = input.startDate ?? null;
        if (input.estimateHours !== undefined) next.estimateHours = input.estimateHours ?? null;
        if (input.parentTaskId !== undefined) next.parentTaskId = input.parentTaskId ?? null;
        if (input.position !== undefined) next.position = input.position;
        if (input.completedAt !== undefined) next.completedAt = input.completedAt ?? null;
        if (input.assigneeId !== undefined) {
          next.assigneeId = input.assigneeId ?? null;
          next.assignee =
            input.assigneeId == null
              ? null
              : findCachedUser(qc, input.assigneeId) ?? next.assignee;
        }
        next.updatedAt = new Date();
        return next;
      });
      return { pages };
    },
    // No onSuccess invalidation - the optimistic patch IS the source of truth
    // while the editor (Board/List/Calendar/Timeline drag-reschedule) is open.
    // A refetch here would restart the kanban reorder loop. Only the
    // dashboard's derived widget queries are refreshed.
    onSuccess: () => invalidateDashboardTaskWidgets(qc),
    onError: (err, _vars, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't save changes");
    },
  });
}
