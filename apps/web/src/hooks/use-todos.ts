'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  CreateTodoInput,
  TodoWithRefs,
  TodoDueFilter,
  UpdateTodoInput,
} from '@botss/shared-types';

import { workspaceMembersKey } from '@/hooks/use-workspace-members';
import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

export interface UseTodosArgs {
  done?: boolean;
  dueDate?: TodoDueFilter;
  limit?: number;
  aggregate?: 'org';
  workspaceId?: string;
  projectId?: string;
}

const todosKey = (args: UseTodosArgs) => ['todos', 'list', args] as const;

export function useTodos(args: UseTodosArgs = {}) {
  return useQuery({
    queryKey: todosKey(args),
    queryFn: () => getApi().todos.list(args),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

export function useCreateTodo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTodoInput) => getApi().todos.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
    },
    meta: { errorTitle: "Couldn't create todo" },
  });
}

export function useUpdateTodo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTodoInput }) =>
      getApi().todos.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['todos'] });
      const snapshots = qc.getQueriesData<{ items: TodoWithRefs[] } | undefined>({
        queryKey: ['todos'],
      });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData(key, {
          ...data,
          items: data.items.map((t) =>
            t.id === id
              ? {
                  ...t,
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  ...(input.notes !== undefined ? { notes: input.notes } : {}),
                  ...(input.priority !== undefined ? { priority: input.priority } : {}),
                  ...(input.dueDate !== undefined ? { dueDate: input.dueDate ?? null } : {}),
                  ...(input.done !== undefined
                    ? {
                        done: input.done,
                        doneAt: input.done ? new Date() : null,
                      }
                    : {}),
                  ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
                }
              : t,
          ),
        });
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [k, v] of ctx.snapshots) qc.setQueryData(k, v);
      }
      toastError(err, "Couldn't update todo");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

export function useDeleteTodo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().todos.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['todos'] });
      const snapshots = qc.getQueriesData<{ items: TodoWithRefs[] } | undefined>({
        queryKey: ['todos'],
      });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData(key, {
          ...data,
          items: data.items.filter((t) => t.id !== id),
        });
      }
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [k, v] of ctx.snapshots) qc.setQueryData(k, v);
      }
      toastError(err, "Couldn't delete todo");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

/**
 * Project + assignee options for the todo composer's "target" picker.
 *
 * Neither endpoint takes a workspace parameter - both are scoped by the
 * request's current-workspace header - so the picked `workspaceId` is NOT
 * part of the query keys (it used to be, which refetched identical data on
 * every pick). Projects are narrowed to the picked workspace client-side;
 * members are the current workspace's (and share its app-wide cache entry).
 * Nothing is fetched until a workspace is picked.
 */
export function useTodoComposerTargets(workspaceId: string) {
  const enabled = !!workspaceId;
  const projects = useQuery({
    queryKey: ['todo-composer', 'projects'],
    queryFn: () => getApi().projects.list({ pageSize: 100 }),
    staleTime: 60_000,
    enabled,
  });
  const members = useQuery({
    queryKey: workspaceMembersKey,
    queryFn: () => getApi().workspaces.currentMembers(),
    staleTime: 60_000,
    enabled,
  });
  const projectsForWorkspace = useMemo(() => {
    if (!workspaceId) return [];
    return (projects.data?.items ?? []).filter((p) => p.workspaceId === workspaceId);
  }, [projects.data, workspaceId]);
  return { projectsForWorkspace, members };
}
