'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  InviteMemberInput,
  InviteMemberResponse,
  UpdateMembershipInput,
  WorkspaceMembershipWithUser,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

export const workspaceMembersKey = ['workspace-members', 'current'] as const;
const workspaceMembersForProjectKey = (projectId: string) =>
  ['workspace-members', 'for-project', projectId] as const;

/**
 * Members of the current workspace. When `projectId` is supplied, fetches the
 * members of the project's workspace instead - required for cross-workspace
 * project collaborators whose own current workspace doesn't contain the project.
 */
export function useWorkspaceMembers(projectId?: string) {
  return useQuery({
    queryKey: projectId ? workspaceMembersForProjectKey(projectId) : workspaceMembersKey,
    queryFn: () =>
      projectId
        ? getApi().workspaces.membersForProject(projectId)
        : getApi().workspaces.currentMembers(),
    staleTime: 5 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useInviteWorkspaceMember() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't invite member" },
    mutationFn: (input: InviteMemberInput) => getApi().workspaces.inviteCurrentMember(input),
    onSuccess: (result: InviteMemberResponse) => {
      // Append the new (or freshly attached) membership row optimistically.
      qc.setQueryData<WorkspaceMembershipWithUser[] | undefined>(workspaceMembersKey, (prev) => {
        if (!prev) return [result.membership];
        // De-duplicate by membership id (Resend reuses the same row).
        const without = prev.filter((m) => m.id !== result.membership.id);
        return [...without, result.membership];
      });
    },
  });
}

export function useUpdateWorkspaceMember() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update member" },
    mutationFn: ({ id, input }: { id: string; input: UpdateMembershipInput }) =>
      getApi().workspaces.updateCurrentMember(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: workspaceMembersKey });
      const prev = qc.getQueryData<WorkspaceMembershipWithUser[]>(workspaceMembersKey);
      if (prev) {
        qc.setQueryData<WorkspaceMembershipWithUser[]>(
          workspaceMembersKey,
          prev.map((m) => (m.id === id ? { ...m, role: input.role, updatedAt: new Date() } : m)),
        );
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(workspaceMembersKey, ctx.prev);
      toastError(err, "Couldn't update member");
    },
  });
}

export function useRemoveWorkspaceMember() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't remove member" },
    mutationFn: (id: string) => getApi().workspaces.removeCurrentMember(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: workspaceMembersKey });
      const prev = qc.getQueryData<WorkspaceMembershipWithUser[]>(workspaceMembersKey);
      if (prev) {
        qc.setQueryData<WorkspaceMembershipWithUser[]>(
          workspaceMembersKey,
          prev.filter((m) => m.id !== id),
        );
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(workspaceMembersKey, ctx.prev);
      toastError(err, "Couldn't remove member");
    },
  });
}

/**
 * Revoke a *pending* invitation. Deletes the membership row + outstanding
 * token. The frontend treats this as a delete-by-id of the membership row.
 */
export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't revoke invitation" },
    mutationFn: (membershipId: string) => getApi().workspaces.revokeInvitation(membershipId),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: workspaceMembersKey });
      const prev = qc.getQueryData<WorkspaceMembershipWithUser[]>(workspaceMembersKey);
      if (prev) {
        qc.setQueryData<WorkspaceMembershipWithUser[]>(
          workspaceMembersKey,
          prev.filter((m) => m.id !== id),
        );
      }
      return { prev };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(workspaceMembersKey, ctx.prev);
      toastError(err, "Couldn't revoke invitation");
    },
  });
}

/**
 * Regenerate the invitation token for a pending membership. Returns the new
 * invitation URL so the caller can show a copy-to-clipboard toast.
 */
export function useResendInvitation() {
  return useMutation({
    meta: { errorTitle: "Couldn't resend invitation" },
    mutationFn: (membershipId: string) => getApi().workspaces.resendInvitation(membershipId),
  });
}
