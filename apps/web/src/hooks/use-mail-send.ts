'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SaveMailDraftInput, SendMailMessageInput } from '@botss/shared-types';

import { rememberRemovedMailId } from '@/hooks/use-mail';
import { getApi } from '@/lib/api';
import { toast } from '@/lib/toast';

export function useSendMail() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't send message" },
    mutationFn: (input: SendMailMessageInput) => getApi().mail.sendMessage(input),
    onSuccess: () => {
      toast.success('Message queued. Delivery confirmation appears in the Sent folder shortly.');
      // The send completes immediately on the API (SMTP -> APPEND to Sent ->
      // self-send INBOX poll). Each of those steps lands at a different time
      // on the IMAP server, so an immediate-only invalidation almost always
      // sees zero/partial new rows. Re-invalidate on the same cadence the
      // backend uses for its self-send INBOX retries (~2s, 7s, 17s, 37s) so
      // the UI catches up without waiting for the 60s background poll.
      const ticks = [1_000, 4_000, 10_000, 20_000, 40_000];
      for (const ms of ticks) {
        setTimeout(() => {
          qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
          qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
        }, ms);
      }
    },
  });
}

/** Save (or replace) a draft on the IMAP DRAFTS folder. */
export function useSaveMailDraft() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save draft" },
    mutationFn: (input: SaveMailDraftInput) => getApi().mail.saveDraft(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
    },
  });
}

export function useDiscardMailDraft() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't discard draft" },
    mutationFn: (draftId: string) => getApi().mail.discardDraft(draftId),
    onMutate: async (draftId) => {
      // Same race as moveMessage: the API removes the draft from IMAP +
      // local DB, IDLE notices, fires SSE, and an SSE-driven refetch can
      // catch the local DB mid-flight. Tombstone the id so it stays out
      // of the cached list during the window.
      rememberRemovedMailId(draftId);
      // Optimistically drop the row from any cached message list so the
      // draft disappears immediately. Restore on error.
      const snapshots = qc.getQueriesData<{ items: { id: string }[] } | undefined>({
        queryKey: ['mail', 'messages'],
      });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData(key, {
          ...data,
          items: data.items.filter((m) => m.id !== draftId),
        });
      }
      return { snapshots };
    },
    onError: (_err, _draftId, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
    },
  });
}
