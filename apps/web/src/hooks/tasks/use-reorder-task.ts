'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReorderTaskInput } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { patchEvery, restore } from './query-helpers';

export function useReorderTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReorderTaskInput }) =>
      getApi().tasks.reorder(id, input),
    onMutate: async ({ input }) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const completedAt = input.status === 'DONE' ? new Date() : null;
      const pages = patchEvery(qc, input.taskId, (t) => ({
        ...t,
        status: input.status,
        position: input.position,
        completedAt,
      }));
      return { pages };
    },
    // No onSuccess invalidation - dnd-kit is mid-animation when this resolves;
    // refetching feeds new positions back into SortableContext and recreates
    // the kanban reorder loop (refetch -> new positions -> another reorder).
    onError: (err, _vars, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't move task");
    },
  });
}
