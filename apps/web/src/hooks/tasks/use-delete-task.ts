'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';
import { invalidateDashboardTaskWidgets, removeEverywhere, restore } from './query-helpers';

export function useDeleteTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().tasks.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['tasks'] });
      const pages = removeEverywhere(qc, id);
      return { pages };
    },
    // No onSuccess invalidation - the task is already removed from every cache
    // page in onMutate; invalidating would refetch and could resurface a stale
    // row before the API's read-after-write window closes. Only the
    // dashboard's derived widget queries are refreshed.
    onSuccess: () => invalidateDashboardTaskWidgets(qc),
    onError: (err, _id, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't delete task");
    },
  });
}
