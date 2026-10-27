'use client';

import { useQuery } from '@tanstack/react-query';
import type { ListTasksQuery } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { tasksKey } from './query-helpers';

export function useTasks(q?: Partial<ListTasksQuery>) {
  return useQuery({
    queryKey: tasksKey(q),
    queryFn: () => getApi().tasks.list(q),
    enabled: !!q?.projectId || !q,
    // The kanban owns task ordering while the page is open. Letting the list
    // refetch after every reorder mutation feeds new positions/`updatedAt`
    // values back into dnd-kit's SortableContext mid-animation, which is the
    // SELECT→UPDATE pump (the "kanban reorder loop").
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
