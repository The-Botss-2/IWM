'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateSavedViewInput, SavedView, UpdateSavedViewInput } from '@botss/shared-types';

import { getApi } from '@/lib/api';

const PINNED = {
  staleTime: 30_000,
  refetchOnMount: false as const,
  refetchOnWindowFocus: false as const,
  refetchOnReconnect: false as const,
};

const savedViewsKey = (projectId: string) => ['saved-views', projectId] as const;

export function useSavedViews(projectId: string) {
  return useQuery({
    queryKey: savedViewsKey(projectId),
    queryFn: () => getApi().savedViews.list(projectId),
    ...PINNED,
  });
}

export function useCreateSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSavedViewInput) => getApi().savedViews.create(projectId, input),
    onSuccess: (view: SavedView) => {
      qc.setQueryData<SavedView[] | undefined>(savedViewsKey(projectId), (prev) =>
        prev ? [...prev, view] : [view],
      );
    },
    meta: { errorTitle: "Couldn't save view" },
  });
}

export function useUpdateSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSavedViewInput }) =>
      getApi().savedViews.update(id, input),
    onSuccess: (view: SavedView) => {
      qc.setQueryData<SavedView[] | undefined>(savedViewsKey(projectId), (prev) =>
        prev?.map((v) => (v.id === view.id ? view : v)),
      );
    },
    meta: { errorTitle: "Couldn't update view" },
  });
}

export function useDeleteSavedView(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().savedViews.remove(id),
    onMutate: (id) => {
      qc.setQueryData<SavedView[] | undefined>(savedViewsKey(projectId), (prev) =>
        prev?.filter((v) => v.id !== id),
      );
    },
    meta: { errorTitle: "Couldn't delete view" },
  });
}
