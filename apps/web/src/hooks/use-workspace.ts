'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UpdateWorkspaceInput, Workspace } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

const currentWorkspaceKey = ['workspace', 'current'] as const;
const workspacesListKey = ['workspaces', 'list'] as const;

/**
 * Every workspace the caller can access (first 50) - the workspace picker,
 * the dashboard filter bar and the todo composer all share this one cache
 * entry. Defaults to a 60s stale time; the bootstrap picker passes
 * `staleTime: 0` so it always revalidates on mount.
 */
export function useWorkspaces(options: { enabled?: boolean; staleTime?: number } = {}) {
  return useQuery({
    queryKey: workspacesListKey,
    queryFn: () => getApi().workspaces.list({ pageSize: 50 }),
    staleTime: options.staleTime ?? 60_000,
    enabled: options.enabled ?? true,
  });
}

export function useCurrentWorkspace() {
  return useQuery({
    queryKey: currentWorkspaceKey,
    queryFn: () => getApi().workspaces.current(),
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useUpdateCurrentWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save workspace" },
    mutationFn: (input: UpdateWorkspaceInput) => getApi().workspaces.updateCurrent(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: currentWorkspaceKey });
      const prev = qc.getQueryData<Workspace>(currentWorkspaceKey);
      if (prev) {
        qc.setQueryData<Workspace>(currentWorkspaceKey, {
          ...prev,
          ...input,
          // Preserve fields the partial patch can't touch.
          description:
            input.description !== undefined ? (input.description ?? null) : prev.description,
          logoUrl: input.logoUrl !== undefined ? (input.logoUrl ?? null) : prev.logoUrl,
          updatedAt: new Date(),
        });
      }
      return { prev };
    },
    onError: (err, _input, ctx) => {
      if (ctx?.prev) qc.setQueryData(currentWorkspaceKey, ctx.prev);
      toastError(err, "Couldn't save workspace");
    },
  });
}
