'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ListMailMessagesQuery,
  MailFolder,
  MailMessage,
  MailMessageListItem,
} from '@botss/shared-types';

import type { MoveMailMessageInput } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { useMailPollInterval } from '@/lib/mail-stream-status';
import { FileTooLargeForNativeError, saveFile } from '@/lib/save-file';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';

type FlagOp = 'read' | 'unread' | 'star' | 'unstar';

const mailFoldersKey = (accountId: string) => ['mail', 'folders', accountId] as const;
const mailMessagesKey = (query: Partial<ListMailMessagesQuery>) =>
  ['mail', 'messages', query] as const;
const mailMessageKey = (id: string) => ['mail', 'message', id] as const;

interface MessageList {
  items: MailMessageListItem[];
  nextCursor: string | null;
}

/**
 * Module-level tombstone set for messages the user just moved/deleted. The
 * server-side fix (delete-before-move + restore-on-failure) closes most of
 * the race, but cross-tab and burst-load scenarios can still surface a
 * just-removed row via the SSE invalidation path. We keep the id here for
 * ~8 seconds - long enough to cover the SSE roundtrip + a couple of poll
 * ticks - and `useMailMessages` filters its items through it.
 *
 * The set is module-scoped (not React state) so it survives across
 * component re-renders and is accessible to both the mutation hook and the
 * list hook without prop-drilling.
 */
const TOMBSTONE_TTL_MS = 8_000;
const tombstone = new Map<string, number>();
/** Exported so other mutation hooks (draft discard, delete, etc.) can also
 *  tombstone an id to prevent SSE-driven refetches from resurrecting it. */
export function rememberRemovedMailId(id: string): void {
  tombstone.set(id, Date.now());
  setTimeout(() => tombstone.delete(id), TOMBSTONE_TTL_MS);
}
function rememberRemoved(id: string): void {
  rememberRemovedMailId(id);
}
function filterTombstoned(list: MessageList | undefined): MessageList | undefined {
  if (!list?.items) return list;
  if (tombstone.size === 0) return list;
  const filtered = list.items.filter((m) => !tombstone.has(m.id));
  if (filtered.length === list.items.length) return list;
  return { ...list, items: filtered };
}

export function useMailFolders(accountId: string | null | undefined) {
  const pollMs = useMailPollInterval();
  return useQuery({
    queryKey: mailFoldersKey(accountId ?? '__none__'),
    queryFn: () => getApi().mail.listFolders(accountId as string),
    enabled: !!accountId,
    staleTime: 10_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
    // Poll on the same cadence as the message list. Without this the folder
    // badge had no convergence path of its own: it moved only on mount, on
    // window focus, or when the SSE `folder-updated` event landed. Whenever
    // that stream was degraded (it is a cross-origin EventSource, so it is
    // the first thing to break behind a proxy or in the desktop shell) the
    // list would show new or read mail while the unread count sat at a
    // number from minutes ago. The request is a cheap DB-side groupBy and
    // TanStack pauses the interval on unfocused tabs. While the SSE stream
    // is connected the poll drops to a slow safety net (see mail-stream-status).
    refetchInterval: accountId ? pollMs : false,
  });
}

const mailRecipientSuggestionsKey = (accountId: string) =>
  ['mail', 'recipient-suggestions', accountId] as const;

/**
 * Addresses the user has previously sent to (from the account's Sent
 * folder), used to populate a `<datalist>` for the compose recipient
 * fields. Fetched once per account and filtered natively by the browser as
 * the user types, so no per-keystroke round-trips.
 */
export function useMailRecipientSuggestions(accountId: string | null | undefined) {
  return useQuery({
    queryKey: mailRecipientSuggestionsKey(accountId ?? '__none__'),
    queryFn: () => getApi().mail.recipientSuggestions(accountId as string, { limit: 50 }),
    enabled: !!accountId,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useMailMessages(query: Partial<ListMailMessagesQuery>) {
  const ready = !!query.accountId || !!query.folderId;
  const pollMs = useMailPollInterval();
  return useQuery({
    queryKey: mailMessagesKey(query),
    queryFn: () => getApi().mail.listMessages(query),
    enabled: ready,
    // Keep the current page visible while the next/previous page loads so
    // Gmail-style paging doesn't blank the list on every step.
    placeholderData: keepPreviousData,
    // Filter out messages the user just moved/deleted within the tombstone
    // window. Prevents an SSE-driven refetch from briefly resurrecting a
    // row that's about to be gone from the server too.
    select: filterTombstoned,
    // Short stale time + refetch-on-mount: every folder click and tab focus
    // re-runs listMessages, which on the API side runs maybeBackgroundSync.
    // That gives the user a "click to refresh" feel without a refresh button.
    staleTime: 5_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
    // Auto-refresh every 10 s so newly-arrived mail (e.g. a time-sensitive
    // OTP) surfaces quickly even when the IMAP IDLE push path (see
    // useMailEvents) is degraded. This is a cheap DB read on the API side -
    // the actual IMAP fetch stays gated by the 60 s background-sync cooldown,
    // so a faster poll here does NOT increase IMAP login pressure. TanStack
    // pauses the interval while the tab is unfocused, so background tabs
    // don't poll. For an immediate fetch the refresh button forces a real
    // IMAP sync on demand. While the SSE stream is connected new mail is
    // pushed, so the poll drops to a slow safety net.
    refetchInterval: ready ? pollMs : false,
  });
}

export function useMailMessage(id: string | null) {
  return useQuery({
    queryKey: mailMessageKey(id ?? '__none__'),
    queryFn: () => getApi().mail.getMessage(id as string),
    enabled: !!id,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Download a mail attachment.
 *
 * The bytes are pulled over the api-client's credentialed transport and saved
 * from a blob URL rather than linking straight at the API endpoint. A direct
 * `<a href>` to the API origin is cross-origin from the web app: the browser
 * drops the `download` attribute and turns the click into a top-level
 * navigation, and inside the Electron desktop shell that navigation is foreign
 * to `APP_ORIGIN`, so `will-navigate` hands the URL to the OS browser - a
 * separate cookie jar, which 401s. Fetching keeps it in-app on every client.
 */
export function useDownloadMailAttachment() {
  return useMutation({
    meta: { errorTitle: "Couldn't download attachment" },
    mutationFn: async ({
      messageId,
      attachmentId,
      filename,
    }: {
      messageId: string;
      attachmentId: string;
      filename: string;
    }) => {
      const res = await getApi().mail.downloadAttachment(messageId, attachmentId);
      // Routed through `saveFile` rather than a local anchor click: inside the
      // mobile WebView an `<a download>` on a blob: URL is silently dropped,
      // which is why attachments would not save on the phone at all.
      await saveFile(res.blob, res.filename || filename);
    },
    onError: (err) => {
      if (err instanceof FileTooLargeForNativeError) {
        toastErrorMessage(
          'That attachment is too large to save on this device. Open it on the desktop app instead.',
        );
        return;
      }
      toastError(err, "Couldn't download that attachment");
    },
  });
}

export function useFlagMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update message" },
    mutationFn: ({ id, op }: { id: string; op: FlagOp }) => getApi().mail.setFlag(id, op),
    onMutate: async ({ id, op }) => {
      // Cancel in-flight mail queries first. The message list polls every
      // 10 s and the folder list now does too, so without this a refetch
      // that started just before the click resolves just after it and
      // writes the pre-click `isUnread: true` straight back over the
      // optimistic patch - the row visibly un-reads itself a moment after
      // you open it, which is the most common shape of "mark as read
      // doesn't work".
      await qc.cancelQueries({ queryKey: ['mail', 'messages'] });
      await qc.cancelQueries({ queryKey: ['mail', 'folders'] });

      // Resolve the affected message (and its folder + read state) BEFORE
      // any cache mutation, so the optimistic folder-count adjustment knows
      // which folder to patch and which way to nudge.
      const target = findCachedMessage(qc, id);

      // 1) Patch every cached message list - flip isUnread / isStarred on
      //    the matching row.
      const previousLists = qc.getQueriesData<MessageList>({ queryKey: ['mail', 'messages'] });
      previousLists.forEach(([key, data]) => {
        if (!data?.items) return;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.map((m) => (m.id === id ? applyFlagListItem(m, op) : m)),
        });
      });

      // 2) Patch the detail cache.
      const previousDetail = qc.getQueryData<MailMessage>(mailMessageKey(id));
      if (previousDetail) {
        qc.setQueryData<MailMessage>(mailMessageKey(id), applyFlagDetail(previousDetail, op));
      }

      // 3) Optimistically tick the folder badge. Without this the sidebar
      //    count only updates after the server-side IMAP roundtrip + folder
      //    refetch, which can take 1–3 seconds and reads as "broken" to the
      //    user. We compute the delta from the *previous* state so a
      //    repeated mark-read on an already-read message doesn't double-
      //    decrement (matches the server-side guard in setSeen).
      const previousFolders = qc.getQueriesData<{ items: MailFolder[] }>({
        queryKey: ['mail', 'folders'],
      });
      if (target && (op === 'read' || op === 'unread')) {
        const wasUnread = target.isUnread;
        const willBeUnread = op === 'unread';
        const delta = wasUnread === willBeUnread ? 0 : willBeUnread ? 1 : -1;
        if (delta !== 0) {
          previousFolders.forEach(([key, data]) => {
            if (!data?.items) return;
            qc.setQueryData<{ items: MailFolder[] }>(key, {
              ...data,
              items: data.items.map((f) =>
                f.id === target.folderId
                  ? { ...f, unreadCount: Math.max(0, f.unreadCount + delta) }
                  : f,
              ),
            });
          });
        }
      }

      return { previousLists, previousDetail, previousFolders };
    },
    onError: (err, { id }, ctx) => {
      if (ctx?.previousLists) {
        for (const [key, data] of ctx.previousLists) qc.setQueryData(key, data);
      }
      if (ctx?.previousFolders) {
        for (const [key, data] of ctx.previousFolders) qc.setQueryData(key, data);
      }
      if (ctx?.previousDetail) {
        qc.setQueryData(mailMessageKey(id), ctx.previousDetail);
      }
      toastError(err, "Couldn't update message");
    },
    onSettled: () => {
      // Belt-and-braces: re-fetch the folder list once the IMAP roundtrip
      // completes so the badge converges on the server-authoritative count
      // even if the optimistic delta diverged (e.g. another tab also
      // flipped the flag).
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/**
 * Best-effort lookup of a message across every cached message-list query.
 * Used by the flag mutation to know which folder's unread badge to nudge
 * before the server roundtrip resolves. Returns `undefined` if the message
 * isn't in any cached list (rare - e.g. the user landed via deep link).
 */
function findCachedMessage(
  qc: ReturnType<typeof useQueryClient>,
  messageId: string,
): MailMessageListItem | undefined {
  const lists = qc.getQueriesData<MessageList>({ queryKey: ['mail', 'messages'] });
  for (const [, data] of lists) {
    const hit = data?.items?.find((m) => m.id === messageId);
    if (hit) return hit;
  }
  // Fall back to the detail cache: the detail row also carries folderId +
  // isUnread, so we can construct a stand-in even without the list cache.
  const detail = qc.getQueryData<MailMessage>(mailMessageKey(messageId));
  if (detail) {
    return {
      id: detail.id,
      accountId: detail.accountId,
      folderId: detail.folderId,
      subject: detail.subject,
      fromAddress: detail.fromAddress,
      fromName: detail.fromName,
      bodyTextPreview: '',
      hasAttachments: detail.attachments.length > 0,
      isUnread: detail.isUnread,
      isStarred: detail.isStarred,
      receivedAt: detail.receivedAt,
    };
  }
  return undefined;
}

/**
 * Move a message to another folder. Optimistically drops the row from any
 * cached list query so the UI feels immediate; rollback on error.
 */
export function useMoveMailMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't move message" },
    mutationFn: ({ id, target }: { id: string; target: MoveMailMessageInput }) =>
      getApi().mail.moveMessage(id, target),
    onMutate: async ({ id }) => {
      // Tombstone the id BEFORE the optimistic update so any concurrent
      // SSE-driven refetch (the IDLE EXPUNGE handler fires the moment the
      // server processes the MOVE, which can race the API response by
      // hundreds of milliseconds) cannot re-surface this row.
      rememberRemoved(id);
      const snapshots = qc.getQueriesData<MessageList>({ queryKey: ['mail', 'messages'] });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.filter((m) => m.id !== id),
        });
      }
      return { snapshots, id };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
      }
      // Move failed on the server - drop the tombstone immediately so the
      // restored row from the server's restore-on-failure path is visible
      // again instead of waiting out the 8s TTL.
      if (ctx?.id) tombstone.delete(ctx.id);
      toastError(err, "Couldn't move message");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/**
 * Bulk move a multi-selection to a destination role/folder. Mirrors
 * useMoveMailMessage's optimistic-remove pattern: drop every selected id
 * from every cached list and tombstone all of them so an SSE-driven
 * refetch can't briefly resurrect them.
 */
export function useBulkMoveMessages() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't move messages" },
    mutationFn: ({ ids, target }: { ids: string[]; target: MoveMailMessageInput }) =>
      getApi().mail.bulkMoveMessages({
        ids,
        ...(target.folderId ? { folderId: target.folderId } : {}),
        ...(target.role ? { role: target.role } : {}),
      }),
    onMutate: async ({ ids }) => {
      // Tombstone first so the SSE EXPUNGE handler can't repopulate.
      const idSet = new Set(ids);
      for (const id of ids) rememberRemoved(id);
      const snapshots = qc.getQueriesData<MessageList>({
        queryKey: ['mail', 'messages'],
      });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.filter((m) => !idSet.has(m.id)),
        });
      }
      return { snapshots, ids };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
      }
      if (ctx?.ids) for (const id of ctx.ids) tombstone.delete(id);
      toastError(err, "Couldn't move messages");
    },
    onSuccess: (res) => {
      if (res.affected === 0) {
        toastErrorMessage("Couldn't move messages", {
          description: 'They may have been moved or deleted already. Refresh and try again.',
        });
      } else {
        const skippedNote = res.skipped > 0 ? ` (${res.skipped} skipped)` : '';
        toast.success(
          `Moved ${res.affected} message${res.affected === 1 ? '' : 's'}${skippedNote}.`,
        );
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/** Bulk read/unread/star/unstar across a multi-selection. Optimistically
 *  patches the matching rows in every cached list + the detail cache. */
export function useBulkFlagMessages() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update messages" },
    mutationFn: ({ ids, op }: { ids: string[]; op: FlagOp }) =>
      getApi().mail.bulkSetFlag({ ids, op }),
    onMutate: async ({ ids, op }) => {
      // See useFlagMessage: a poll already in flight would otherwise undo
      // the whole selection's optimistic patch.
      await qc.cancelQueries({ queryKey: ['mail', 'messages'] });
      await qc.cancelQueries({ queryKey: ['mail', 'folders'] });
      const idSet = new Set(ids);
      const previousLists = qc.getQueriesData<MessageList>({
        queryKey: ['mail', 'messages'],
      });
      previousLists.forEach(([key, data]) => {
        if (!data?.items) return;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.map((m) => (idSet.has(m.id) ? applyFlagListItem(m, op) : m)),
        });
      });
      // Patch detail caches for any open messages in the selection.
      const previousDetails: { id: string; data: MailMessage | undefined }[] = [];
      for (const id of ids) {
        const detail = qc.getQueryData<MailMessage>(mailMessageKey(id));
        previousDetails.push({ id, data: detail });
        if (detail) {
          qc.setQueryData<MailMessage>(mailMessageKey(id), applyFlagDetail(detail, op));
        }
      }
      return { previousLists, previousDetails };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previousLists) {
        for (const [k, v] of ctx.previousLists) qc.setQueryData(k, v);
      }
      if (ctx?.previousDetails) {
        for (const { id, data } of ctx.previousDetails) {
          if (data) qc.setQueryData(mailMessageKey(id), data);
        }
      }
      toastError(err, "Couldn't update messages");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/** Permanently delete a multi-selection. Server restricts this to messages
 *  whose source folder is Trash/Spam - anything else is silently skipped. */
export function useBulkDeleteMessages() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete messages" },
    mutationFn: ({ ids }: { ids: string[] }) => getApi().mail.bulkDeleteMessages({ ids }),
    onMutate: async ({ ids }) => {
      const idSet = new Set(ids);
      for (const id of ids) rememberRemoved(id);
      const snapshots = qc.getQueriesData<MessageList>({
        queryKey: ['mail', 'messages'],
      });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.filter((m) => !idSet.has(m.id)),
        });
      }
      return { snapshots, ids };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) {
        for (const [k, v] of ctx.snapshots) qc.setQueryData(k, v);
      }
      if (ctx?.ids) for (const id of ctx.ids) tombstone.delete(id);
      toastError(err, "Couldn't delete messages");
    },
    onSuccess: (res) => {
      if (res.affected === 0) {
        toastErrorMessage(
          'Nothing was deleted. Only Trash/Spam messages can be permanently removed.',
        );
      } else {
        const skippedNote = res.skipped > 0 ? ` (${res.skipped} skipped)` : '';
        toast.success(
          `Deleted ${res.affected} message${res.affected === 1 ? '' : 's'}${skippedNote}.`,
        );
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/** Mark every unread message in a folder as read. Optimistically clears the
 *  unread badge on the folder + zeros the `isUnread` flag on every cached
 *  message in that folder. */
export function useMarkFolderAllRead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't mark folder as read" },
    mutationFn: (folderId: string) => getApi().mail.markFolderAllRead(folderId),
    onMutate: async (folderId) => {
      await qc.cancelQueries({ queryKey: ['mail', 'messages'] });
      await qc.cancelQueries({ queryKey: ['mail', 'folders'] });
      const lists = qc.getQueriesData<MessageList>({ queryKey: ['mail', 'messages'] });
      for (const [key, data] of lists) {
        if (!data?.items) continue;
        qc.setQueryData<MessageList>(key, {
          ...data,
          items: data.items.map((m) => (m.folderId === folderId ? { ...m, isUnread: false } : m)),
        });
      }
      // Zero the badge in the same tick as the rows. Previously only the
      // messages were patched and the count waited on the refetch in
      // onSettled, so the folder kept its old number for a second or two
      // after every row had visibly gone un-bold.
      const folders = qc.getQueriesData<{ items: MailFolder[] }>({
        queryKey: ['mail', 'folders'],
      });
      for (const [key, data] of folders) {
        if (!data?.items) continue;
        qc.setQueryData<{ items: MailFolder[] }>(key, {
          ...data,
          items: data.items.map((f) => (f.id === folderId ? { ...f, unreadCount: 0 } : f)),
        });
      }
      return { lists, folders };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.lists) for (const [k, v] of ctx.lists) qc.setQueryData(k, v);
      if (ctx?.folders) for (const [k, v] of ctx.folders) qc.setQueryData(k, v);
      toastError(err, "Couldn't mark all read");
    },
    onSuccess: (res) => {
      if (res.updated === 0) toast.success('Already up to date.');
      else toast.success(`Marked ${res.updated} message${res.updated === 1 ? '' : 's'} as read.`);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
    },
  });
}

/** Permanently delete every message in Trash or Spam. */
export function useEmptyFolder() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't empty folder" },
    mutationFn: (folderId: string) => getApi().mail.emptyFolder(folderId),
    onSuccess: (res) => {
      toast.success(
        res.deleted === 0
          ? 'Folder is already empty.'
          : `Deleted ${res.deleted} message${res.deleted === 1 ? '' : 's'}.`,
      );
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/**
 * Re-fetch every message of one folder from IMAP to heal drifted rows
 * (missing attachments, stale flags). Slow on big folders, so the server
 * queues it as a background job and answers at once (202); it allows one
 * per folder every 2 minutes (429 otherwise). The folder's lists and counts
 * are re-read afterwards, and the mail list's regular refresh picks up the
 * rows the job rewrites while it runs.
 */
export function useResyncMailFolder() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't resync folder" },
    mutationFn: (folderId: string) => getApi().mail.resyncFolder(folderId),
    onSuccess: () => {
      toast.success('Folder resync started. Messages update as it runs.');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    },
  });
}

/**
 * Trigger a manual IMAP sync (folders + INBOX recent messages). Backs the
 * mail list's refresh button: forces an immediate IMAP fetch, debounced
 * server-side to one real fetch every 5 s per account.
 *
 * Quiet by design - the button gets pressed repeatedly while waiting on a
 * slow OTP, so success is silent (the new mail simply appears in the list).
 * Only hard failures surface a toast.
 */
export function useSyncMailAccount() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't refresh mail" },
    mutationFn: (accountId: string) => getApi().mail.syncAccount(accountId),
    onSuccess: (res, accountId) => {
      if (!res.ok) toastError(res.error, "Couldn't refresh mail");
      qc.invalidateQueries({ queryKey: ['mail', 'folders', accountId] });
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
    },
  });
}

function applyFlagListItem(m: MailMessageListItem, op: FlagOp): MailMessageListItem {
  switch (op) {
    case 'read':
      return { ...m, isUnread: false };
    case 'unread':
      return { ...m, isUnread: true };
    case 'star':
      return { ...m, isStarred: true };
    case 'unstar':
      return { ...m, isStarred: false };
  }
}

function applyFlagDetail(m: MailMessage, op: FlagOp): MailMessage {
  switch (op) {
    case 'read':
      return { ...m, isUnread: false };
    case 'unread':
      return { ...m, isUnread: true };
    case 'star':
      return { ...m, isStarred: true };
    case 'unstar':
      return { ...m, isStarred: false };
  }
}

export { type MailFolder, type MailMessage, type MailMessageListItem };
