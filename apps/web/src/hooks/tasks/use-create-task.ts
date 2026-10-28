'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTaskInput, ListTasksQuery, TaskWithPeople } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import {
  findCachedUser,
  invalidateDashboardTaskWidgets,
  snapshotPages,
  type TaskListPage,
} from './query-helpers';

export function useCreateTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => getApi().tasks.create(input),
    meta: { successMessage: 'Task created.', errorTitle: "Couldn't create task" },
    onSuccess: (created) => {
      // Append the created task to every cached page for this project. Pull
      // author/assignee from any workspace member cache when available so the
      // new card renders with the same shape as the rest of the list.
      const author = findCachedUser(qc, created.createdById) ?? {
        id: created.createdById,
        name: 'You',
        email: '',
        image: null,
      };
      const assignee =
        created.assigneeId == null ? null : (findCachedUser(qc, created.assigneeId) ?? null);
      const taskWithPeople: TaskWithPeople = {
        ...created,
        createdBy: author,
        assignee,
      };
      const pages = snapshotPages(qc);
      for (const [key, data] of pages) {
        if (!data?.items) continue;
        const queryKey = key as readonly [string, Partial<ListTasksQuery> | undefined];
        const q = queryKey[1];
        if (q?.projectId && q.projectId !== created.projectId) continue;
        qc.setQueryData<TaskListPage>(key, {
          ...data,
          items: [...data.items, taskWithPeople],
        });
      }
      // No invalidateQueries - the server response above is already merged into
      // every cached page; invalidating would refetch into Board/List/Calendar/
      // Timeline mid-render and re-trigger the documented kanban reorder loop.
      // Only the dashboard's derived widget queries are refreshed.
      invalidateDashboardTaskWidgets(qc);
    },
  });
}
