'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminCreateUserInput,
  AdminImportWebmailUserInput,
  AdminUpdateUserInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

const KEY = ['admin', 'users'] as const;
const WEBMAIL_KEY = ['admin', 'users', 'webmail-candidates'] as const;

export function useAdminUsers(params?: { search?: string }) {
  const search = params?.search;
  return useQuery({
    queryKey: [...KEY, search ?? ''],
    queryFn: () => getApi().admin.listUsers(search ? { search } : {}),
    staleTime: 10_000,
  });
}

export function useCreateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create user" },
    mutationFn: (input: AdminCreateUserInput) => getApi().admin.createUser(input),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(`Created ${created.email}.`);
    },
  });
}

export function useUpdateAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update user" },
    mutationFn: ({ id, input }: { id: string; input: AdminUpdateUserInput }) =>
      getApi().admin.updateUser(id, input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(`Updated ${updated.email}.`);
    },
  });
}

/** cPanel mailboxes that exist in webmail but aren't yet in the CRM. */
export function useWebmailCandidates(enabled: boolean) {
  return useQuery({
    queryKey: WEBMAIL_KEY,
    queryFn: () => getApi().admin.listWebmailCandidates(),
    staleTime: 30_000,
    enabled,
  });
}

export function useImportWebmailUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't import webmail user" },
    mutationFn: (input: AdminImportWebmailUserInput) =>
      getApi().admin.importWebmailUser(input),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: WEBMAIL_KEY });
      toast.success(`Imported ${created.email}.`);
    },
  });
}

export function useRevokeUserSessions() {
  return useMutation({
    meta: { errorTitle: "Couldn't sign the user out" },
    mutationFn: (id: string) => getApi().admin.revokeUserSessions(id),
    onSuccess: ({ revoked }) => {
      toast.success(
        revoked === 0
          ? 'That user had no active sessions.'
          : `Signed the user out of ${revoked} ${revoked === 1 ? 'session' : 'sessions'}.`,
      );
    },
  });
}

export function useDeleteAdminUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete user" },
    mutationFn: (id: string) => getApi().admin.deleteUser(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success('User deleted.');
    },
  });
}
