'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddProjectMemberInput,
  ProjectMembershipWithUser,
  UpdateProjectMemberInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { findCachedUser } from '@/lib/member-cache';
import { toastError } from '@/lib/toast';

const projectMembersKey = (projectId: string) =>
  ['project-members', projectId] as const;

export function useProjectMembers(projectId: string) {
  return useQuery({
    queryKey: projectMembersKey(projectId),
    queryFn: () => getApi().projectMembers.list(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useAddProjectMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddProjectMemberInput) =>
      getApi().projectMembers.add(projectId, input),
    onSuccess: (created) => {
      // Synthesize a row with user info pulled from any cached members list.
      const user = findCachedUser(qc, created.userId) ?? {
        id: created.userId,
        name: '',
        email: '',
        image: null,
      };
      const row: ProjectMembershipWithUser = { ...created, user };
      qc.setQueryData<ProjectMembershipWithUser[] | undefined>(
        projectMembersKey(projectId),
        (prev) => (prev ? [...prev, row] : [row]),
      );
    },
    meta: { errorTitle: "Couldn't add member" },
  });
}

export function useUpdateProjectMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateProjectMemberInput }) =>
      getApi().projectMembers.update(projectId, id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: projectMembersKey(projectId) });
      const prev = qc.getQueryData<ProjectMembershipWithUser[]>(projectMembersKey(projectId));
      if (prev) {
        qc.setQueryData<ProjectMembershipWithUser[]>(
          projectMembersKey(projectId),
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  role: input.role ?? m.role,
                  abilities: (input.abilities ?? m.abilities) as ProjectMembershipWithUser['abilities'],
                  updatedAt: new Date(),
                }
              : m,
          ),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(projectMembersKey(projectId), ctx.prev);
      toastError(err, "Couldn't update member");
    },
  });
}

export function useRemoveProjectMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().projectMembers.remove(projectId, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: projectMembersKey(projectId) });
      const prev = qc.getQueryData<ProjectMembershipWithUser[]>(projectMembersKey(projectId));
      if (prev) {
        qc.setQueryData<ProjectMembershipWithUser[]>(
          projectMembersKey(projectId),
          prev.filter((m) => m.id !== id),
        );
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(projectMembersKey(projectId), ctx.prev);
      toastError(err, "Couldn't remove member");
    },
  });
}
