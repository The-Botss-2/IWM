'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddMailAccountInput,
  CreateMailSignatureInput,
  MailAccount,
  UpdateMailAccountInput,
  UpdateMailSignatureInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

const mailAccountsKey = ['mail', 'accounts'] as const;

type AccountList = { items: MailAccount[] };

/**
 * Hook for the `/settings/mail` page. While an account is in CONNECTING state
 * we poll every 2s so the UI surfaces the verify-account outcome without a
 * page reload. Once everything is ACTIVE / AUTH_FAILED / CONNECTION_FAILED,
 * polling stops and we fall back to the standard staleTime model.
 */
export function useMailAccounts() {
  return useQuery({
    queryKey: mailAccountsKey,
    queryFn: () => getApi().mail.listAccounts(),
    staleTime: 15_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => {
      const data = query.state.data as AccountList | undefined;
      const anyConnecting = data?.items.some((a) => a.status === 'CONNECTING');
      return anyConnecting ? 2000 : false;
    },
  });
}

export function useAddMailAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't add mail account" },
    mutationFn: (input: AddMailAccountInput) => getApi().mail.addAccount(input),
    onSuccess: (created) => {
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => ({
        items: [...(curr?.items ?? []).filter((a) => a.id !== created.id), created],
      }));
    },
  });
}

/** One-click setup for cPanel-managed users. Resets the cPanel mailbox
 *  password to the supplied value and provisions a MailAccount. */
export function useSelfSetupMailbox() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't set up mailbox" },
    mutationFn: (password: string) => getApi().mail.selfSetupMailbox(password),
    onSuccess: (created) => {
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => ({
        items: [...(curr?.items ?? []).filter((a) => a.id !== created.id), created],
      }));
      toast.success(`Mailbox ${created.email} configured.`);
    },
  });
}

export function useUpdateMailAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update mail account" },
    mutationFn: ({ id, input }: { id: string; input: UpdateMailAccountInput }) =>
      getApi().mail.updateAccount(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: mailAccountsKey });
      const previous = qc.getQueryData<AccountList>(mailAccountsKey);
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => {
        if (!curr) return curr;
        return {
          items: curr.items.map((a) =>
            a.id === id ? { ...a, ...stripPassword(input) } : a,
          ),
        };
      });
      return { previous };
    },
    onSuccess: (server) => {
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => {
        if (!curr) return curr;
        return { items: curr.items.map((a) => (a.id === server.id ? server : a)) };
      });
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(mailAccountsKey, ctx.previous);
      toastError(err, "Couldn't update mail account");
    },
  });
}

export function useTestMailAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't test mail account" },
    mutationFn: (id: string) => getApi().mail.testAccount(id),
    onSuccess: (result, id) => {
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => {
        if (!curr) return curr;
        return {
          items: curr.items.map((a) =>
            a.id === id ? { ...a, status: result.status, lastError: result.error } : a,
          ),
        };
      });
      if (result.ok) {
        toast.success('Mail account verified.');
      } else {
        toastError(result.error, "Couldn't verify mail account");
      }
    },
  });
}

/** Replace one account in the cached list with the server's fresh copy. */
function useReplaceAccountInCache() {
  const qc = useQueryClient();
  return (server: MailAccount) => {
    qc.setQueryData<AccountList>(mailAccountsKey, (curr) => {
      if (!curr) return curr;
      return { items: curr.items.map((a) => (a.id === server.id ? server : a)) };
    });
  };
}

export function useAddMailSignature() {
  const replace = useReplaceAccountInCache();
  return useMutation({
    meta: { errorTitle: "Couldn't add signature" },
    mutationFn: ({
      accountId,
      input,
    }: {
      accountId: string;
      input: CreateMailSignatureInput;
    }) => getApi().mail.addSignature(accountId, input),
    onSuccess: replace,
  });
}

export function useUpdateMailSignature() {
  const replace = useReplaceAccountInCache();
  return useMutation({
    meta: { errorTitle: "Couldn't save signature" },
    mutationFn: ({
      accountId,
      signatureId,
      input,
    }: {
      accountId: string;
      signatureId: string;
      input: UpdateMailSignatureInput;
    }) => getApi().mail.updateSignature(accountId, signatureId, input),
    onSuccess: replace,
  });
}

export function useRemoveMailSignature() {
  const replace = useReplaceAccountInCache();
  return useMutation({
    meta: { errorTitle: "Couldn't delete signature" },
    mutationFn: ({
      accountId,
      signatureId,
    }: {
      accountId: string;
      signatureId: string;
    }) => getApi().mail.removeSignature(accountId, signatureId),
    onSuccess: replace,
  });
}

export function useRemoveMailAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't disconnect mail account", successMessage: 'Mail account disconnected' },
    mutationFn: (id: string) => getApi().mail.removeAccount(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: mailAccountsKey });
      const previous = qc.getQueryData<AccountList>(mailAccountsKey);
      qc.setQueryData<AccountList>(mailAccountsKey, (curr) => {
        if (!curr) return curr;
        return { items: curr.items.filter((a) => a.id !== id) };
      });
      return { previous };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(mailAccountsKey, ctx.previous);
      toastError(err, "Couldn't remove mail account");
    },
  });
}

/** Sanitize patch input before merging it into the cache. The cache shape
 *  never includes `password`, so dropping it here keeps types honest. */
function stripPassword(input: UpdateMailAccountInput) {
  const { password: _omit, ...rest } = input;
  return rest;
}
