'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ChatRoomListResponse,
  ChatRoomMessage,
  ChatRoomMessagesResponse,
  ChatRoomSummary,
  CreateChatRoomInput,
  MessageStatus,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

export const chatRoomsKey = ['chat', 'rooms'] as const;
export const chatMessagesKey = (roomId: string) => ['chat', 'messages', roomId] as const;

function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date();
}

function asNullableDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return asDate(value);
}

export function hydrateMessage<T extends ChatRoomMessage & Record<string, unknown>>(raw: T): T {
  return {
    ...raw,
    createdAt: asDate(raw.createdAt),
    editedAt: asNullableDate(raw.editedAt),
    deletedAt: asNullableDate(raw.deletedAt),
    parentMessage: raw.parentMessage
      ? {
          ...raw.parentMessage,
          createdAt: asDate(raw.parentMessage.createdAt),
          deletedAt: asNullableDate(raw.parentMessage.deletedAt),
        }
      : (raw.parentMessage ?? null),
  };
}

export function useChatRooms(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: chatRoomsKey,
    queryFn: () => getApi().chat.listRooms(),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    enabled: options.enabled ?? true,
  });
}

export function useRoomMessages(roomId: string | null) {
  return useQuery({
    queryKey: chatMessagesKey(roomId ?? '__none__'),
    queryFn: () => getApi().chat.listMessages({ roomId: roomId as string, limit: 50 }),
    enabled: !!roomId,
    staleTime: 5_000,
    refetchOnWindowFocus: false,
  });
}

export function useAddParticipants(roomId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't add members" },
    mutationFn: (userIds: string[]) => getApi().chat.addParticipants(roomId, { userIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

export function useRemoveParticipant(roomId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't remove member" },
    mutationFn: (userId: string) => getApi().chat.removeParticipant(roomId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

export function useLeaveRoom() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't leave chat" },
    mutationFn: (roomId: string) => getApi().chat.leaveRoom(roomId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

export function useToggleReaction() {
  return useMutation({
    meta: { errorTitle: "Couldn't react to message" },
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      getApi().chat.toggleReaction(messageId, emoji),
  });
}

export function applyReactionUpdate(
  qc: QueryClient,
  roomId: string,
  messageId: string,
  reactions: { emoji: string; count: number; reactedByMe: boolean; userIds: string[] }[],
): void {
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      items: prev.items.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
    };
  });
}

export function useRenameRoom() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't rename chat" },
    mutationFn: ({ roomId, name }: { roomId: string; name: string }) =>
      getApi().chat.renameRoom(roomId, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

export function useUpdateRoom() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update chat" },
    mutationFn: ({
      roomId,
      name,
      description,
      isPrivate,
    }: {
      roomId: string;
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
    }) =>
      getApi().chat.updateRoom(roomId, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(isPrivate !== undefined ? { isPrivate } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

/**
 * Apply an edited message into the open chat cache (used by both the edit
 * mutation's onSuccess and the `msg_updated` socket event). Swaps the message
 * body in place and refreshes the room's lastMessage preview if it was the one
 * edited.
 */
export function applyMessageUpdate(qc: QueryClient, roomId: string, raw: ChatRoomMessage): void {
  const message = hydrateMessage(raw as ChatRoomMessage & Record<string, unknown>);
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      items: prev.items.map((m) => (m.id === message.id ? message : m)),
    };
  });
  qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
    if (!prev) return prev;
    return {
      items: prev.items.map((r) =>
        r.id === roomId && r.lastMessage?.id === message.id ? { ...r, lastMessage: message } : r,
      ),
    };
  });
}

export function useEditMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't edit message" },
    mutationFn: ({ messageId, content }: { messageId: string; content: string }) =>
      getApi().chat.editMessage(messageId, { content }),
    onSuccess: ({ message }) => applyMessageUpdate(qc, message.roomId, message),
  });
}

export function useForwardMessages() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't forward messages" },
    mutationFn: ({ targetRoomId, messageIds }: { targetRoomId: string; messageIds: string[] }) =>
      getApi().chat.forwardMessages(targetRoomId, messageIds),
    onSuccess: () => {
      // The forwarder may not have the target room open; nudge the room list so
      // its lastMessage/ordering refreshes even without the socket echo.
      // No success toast here: the forward dialog may call this once per
      // target chat and shows one summary toast when all of them finish.
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

/**
 * Load the previous page of messages (older than what's currently in cache)
 * and prepend them. Uses the `nextCursor` the messages query already holds.
 * This is the fix for "messages older than ~a week don't show": the room view
 * only ever fetched the most recent 50, with no way to page backwards.
 */
export function useLoadOlderMessages(roomId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't load older messages" },
    mutationFn: async () => {
      if (!roomId) return null;
      const current = qc.getQueryData<ChatRoomMessagesResponse>(chatMessagesKey(roomId));
      const cursor = current?.nextCursor ?? undefined;
      if (!cursor) return null; // reached the start of history
      return getApi().chat.listMessages({ roomId, cursor, limit: 50 });
    },
    onSuccess: (result) => {
      if (!roomId || !result) return;
      qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
        if (!prev) return result;
        const existing = new Set(prev.items.map((m) => m.id));
        // api-client already coerced dates; just de-dupe against what's loaded.
        const older = result.items.filter((m) => !existing.has(m.id));
        return {
          items: [...older, ...prev.items],
          nextCursor: result.nextCursor,
        };
      });
    },
  });
}

export function useDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete message" },
    mutationFn: (messageId: string) => getApi().chat.deleteMessage(messageId),
    onSuccess: (result) => {
      qc.setQueryData<ChatRoomMessagesResponse | undefined>(
        chatMessagesKey(result.roomId),
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items.map((m) =>
              m.id === result.messageId ? { ...m, deletedAt: new Date(), content: null } : m,
            ),
          };
        },
      );
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
  });
}

export function useClearRoomMessages() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't clear chat" },
    mutationFn: (roomId: string) => getApi().chat.clearRoomMessages(roomId),
    onSuccess: (result) => {
      qc.setQueryData<ChatRoomMessagesResponse | undefined>(
        chatMessagesKey(result.roomId),
        (prev) => {
          if (!prev) return prev;
          return { ...prev, items: [] };
        },
      );
      qc.invalidateQueries({ queryKey: chatRoomsKey });
      toast.success(`Cleared ${result.cleared} messages.`);
    },
  });
}

/**
 * Persistent mark-as-read. Hits the REST endpoint so the action survives
 * a reload (the cache-only `clearUnread` does not). Optimistically zeroes
 * the room's `unreadCount` and bumps every message in the cache to READ,
 * then re-validates after the response so the sender's blue ticks land
 * via the same path the socket broadcast would use.
 */
export function useMarkRoomRead() {
  const qc = useQueryClient();
  return useMutation({
    // Fired automatically on room open; a failure only means the unread
    // badge rolls back (onError below) - not worth interrupting the user.
    meta: { silentError: true },
    mutationFn: (roomId: string) => getApi().chat.markRoomRead(roomId),
    onMutate: async (roomId) => {
      await qc.cancelQueries({ queryKey: chatRoomsKey });
      const previous = qc.getQueryData<ChatRoomListResponse>(chatRoomsKey);
      qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
        if (!prev) return prev;
        return {
          items: prev.items.map((r) => (r.id === roomId ? { ...r, unreadCount: 0 } : r)),
        };
      });
      return { previous };
    },
    onError: (_err, _roomId, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRoomsKey, ctx.previous);
    },
    onSuccess: (result, roomId) => {
      // Bump every targeted message's status to READ in the open chat
      // window's cache; harmless if the messages aren't loaded.
      qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
        if (!prev) return prev;
        if (result.messageIds.length === 0) return prev;
        const ids = new Set(result.messageIds);
        return {
          ...prev,
          items: prev.items.map((m) => (ids.has(m.id) ? { ...m, status: 'READ' as const } : m)),
        };
      });
    },
  });
}

export function useCreateChatRoom() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create chat" },
    mutationFn: (input: CreateChatRoomInput) => getApi().chat.createRoom(input),
    onSuccess: (room: ChatRoomSummary) => {
      qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
        if (!prev) return { items: [room] };
        if (prev.items.some((r) => r.id === room.id)) return prev;
        return { items: [room, ...prev.items] };
      });
      toast.success(room.type === 'DM' ? 'Chat ready.' : `${room.name ?? 'Group'} created.`);
    },
    onError: (err) => {
      console.error('[chat] createRoom failed:', err);
      toastError(err, "Couldn't create chat");
    },
  });
}

export function appendIncomingRoomMessage(
  qc: QueryClient,
  roomId: string,
  raw: ChatRoomMessage & { clientNonce?: string | null },
): void {
  const message = hydrateMessage(
    raw as ChatRoomMessage & Record<string, unknown>,
  ) as ChatRoomMessage & { clientNonce?: string | null };
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
    if (!prev) return { items: [message], nextCursor: null };
    if (prev.items.some((m) => m.id === message.id)) return prev;
    if (message.clientNonce) {
      const idx = prev.items.findIndex(
        (m) =>
          m.id.startsWith('tmp:') &&
          (m as ChatRoomMessage & { clientNonce?: string }).clientNonce === message.clientNonce,
      );
      if (idx >= 0) {
        const next = [...prev.items];
        next[idx] = message;
        return { ...prev, items: next };
      }
    }
    return { ...prev, items: [...prev.items, message] };
  });
}

export function insertOptimisticRoomMessage(
  qc: QueryClient,
  roomId: string,
  message: ChatRoomMessage & { clientNonce: string },
): void {
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
    if (!prev) return { items: [message], nextCursor: null };
    return { ...prev, items: [...prev.items, message] };
  });
  // Re-sort the sidebar immediately. Waiting for the server's `room_bumped`
  // echo means the room the user just typed in visibly lags behind rooms
  // with older messages until the round-trip lands.
  bumpRoom(qc, roomId, message, true);
}

/** Drop an optimistic message from the cache (e.g. the user cancelled an
 *  in-flight attachment upload, or a send failed). No-op if not present. */
export function removeRoomMessage(qc: QueryClient, roomId: string, messageId: string): void {
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) =>
    prev ? { ...prev, items: prev.items.filter((m) => m.id !== messageId) } : prev,
  );
  // The optimistic insert also bumped the sidebar preview to this message.
  // Now that it's gone, re-fetch the room list so the preview falls back to
  // whatever the real last message is instead of showing a phantom.
  const rooms = qc.getQueryData<ChatRoomListResponse>(chatRoomsKey);
  if (rooms?.items.some((r) => r.id === roomId && r.lastMessage?.id === messageId)) {
    void qc.invalidateQueries({ queryKey: chatRoomsKey });
  }
}

function statusRank(s: MessageStatus): number {
  if (s === 'READ') return 3;
  if (s === 'DELIVERED') return 2;
  return 1;
}

export function applyStatusUpdate(
  qc: QueryClient,
  roomId: string,
  status: MessageStatus,
  messageIds?: string[],
  /// When the broadcast represents the CURRENT user marking the room as
  /// read (i.e. `byUserId === selfUserId`), also drop the room's
  /// unreadCount to zero so the sidebar badge clears live without
  /// needing a refetch. For peer-driven updates we leave unreadCount
  /// alone - only `bumpRoom` should grow it.
  isSelfRead?: boolean,
): void {
  const ids = messageIds ? new Set(messageIds) : null;
  qc.setQueryData<ChatRoomMessagesResponse | undefined>(chatMessagesKey(roomId), (prev) => {
    if (!prev) return prev;
    return {
      ...prev,
      items: prev.items.map((m) => {
        if (m.id.startsWith('tmp:')) return m;
        if (ids && !ids.has(m.id)) return m;
        if (statusRank(m.status) >= statusRank(status)) return m;
        return { ...m, status };
      }),
    };
  });
  qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
    if (!prev) return prev;
    return {
      items: prev.items.map((room) => {
        if (room.id !== roomId) return room;
        let next = room;
        if (isSelfRead && status === 'READ') {
          next = { ...next, unreadCount: 0 };
        }
        if (!next.lastMessage) return next;
        if (ids && !ids.has(next.lastMessage.id)) return next;
        if (statusRank(next.lastMessage.status) >= statusRank(status)) return next;
        return { ...next, lastMessage: { ...next.lastMessage, status } };
      }),
    };
  });
}

/**
 * Move a room to the top of the sidebar and refresh its preview row.
 *
 * Returns `false` when the room isn't in the cached list yet (a brand new DM,
 * or a channel the user was just added to) - the caller should fall back to
 * refetching in that case. Returning `true` lets callers SKIP the refetch,
 * which matters on busy channels where a blanket invalidate meant one full
 * room-list round-trip per incoming message.
 */
export function bumpRoom(
  qc: QueryClient,
  roomId: string,
  rawLast: ChatRoomMessage,
  isSelf: boolean,
): boolean {
  const lastMessage = hydrateMessage(rawLast as ChatRoomMessage & Record<string, unknown>);
  let applied = false;
  qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
    if (!prev) return prev;
    const idx = prev.items.findIndex((r) => r.id === roomId);
    if (idx < 0) return prev;
    const current = prev.items[idx]!;
    // Ignore an out-of-order echo: a stale broadcast must not drag a room
    // back down or overwrite a newer preview. An optimistic row (`tmp:` id)
    // is always superseded - its createdAt is the CLIENT's clock, so on a
    // machine running fast it would otherwise beat every real message and
    // pin the preview to a placeholder forever.
    if (
      current.lastMessage &&
      !current.lastMessage.id.startsWith('tmp:') &&
      current.lastMessage.id !== lastMessage.id &&
      current.lastMessage.createdAt > lastMessage.createdAt
    ) {
      applied = true;
      return prev;
    }
    // Re-delivery of a message already sitting in the preview (the optimistic
    // insert followed by the server echo) must not double-count unread.
    const isRepeat = current.lastMessage?.id === lastMessage.id;
    applied = true;
    const updated: ChatRoomSummary = {
      ...current,
      lastMessage,
      updatedAt: lastMessage.createdAt,
      unreadCount: isSelf || isRepeat ? current.unreadCount : current.unreadCount + 1,
    };
    const without = prev.items.filter((_, i) => i !== idx);
    return { items: [updated, ...without] };
  });
  return applied;
}

/**
 * Detects cross-app share messages (POST /chat/share). Content shape:
 * `__share__:TYPE:ID:JSON_PAYLOAD`. Returns null for regular messages.
 */
export type ParsedShareCard = {
  itemType: 'task' | 'timesheet' | 'todo' | 'email';
  itemId: string;
  title: string;
  subtitle: string | null;
  link: string;
};
export function parseShareCard(content: string | null): ParsedShareCard | null {
  if (!content || !content.startsWith('__share__:')) return null;
  // Split with a hard limit so JSON payloads containing `:` survive.
  const rest = content.slice('__share__:'.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const itemType = rest.slice(0, firstColon);
  const after = rest.slice(firstColon + 1);
  const secondColon = after.indexOf(':');
  if (secondColon < 0) return null;
  const itemId = after.slice(0, secondColon);
  const json = after.slice(secondColon + 1);
  if (
    itemType !== 'task' &&
    itemType !== 'timesheet' &&
    itemType !== 'todo' &&
    itemType !== 'email'
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(json) as {
      title?: string;
      subtitle?: string | null;
      link?: string;
    };
    return {
      itemType,
      itemId,
      title: typeof parsed.title === 'string' ? parsed.title : '(shared item)',
      subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : null,
      link: typeof parsed.link === 'string' ? parsed.link : '#',
    };
  } catch {
    return null;
  }
}

/**
 * Detects messages produced by the call lifecycle (see `recordCallLog` in
 * the API). Content shape: `__call__:STATUS:DURATION_SECONDS`. Returns
 * null for regular messages.
 */
export type ParsedCallLog = {
  status: 'COMPLETED' | 'MISSED' | 'REJECTED';
  durationSec: number;
};
export function parseCallLog(content: string | null): ParsedCallLog | null {
  if (!content || !content.startsWith('__call__:')) return null;
  const parts = content.split(':');
  if (parts.length !== 3) return null;
  const status = parts[1];
  const durationSec = Number(parts[2]);
  if (status !== 'COMPLETED' && status !== 'MISSED' && status !== 'REJECTED') {
    return null;
  }
  if (!Number.isFinite(durationSec)) return null;
  return { status, durationSec };
}

/**
 * Detects membership-change system messages (see `recordSystemMessage` in
 * the API). Content shape: `__system__:<event>:<JSON payload>`. The payload
 * is JSON, so member names containing `:` survive intact. Returns null for
 * regular messages.
 */
export type ParsedSystemMessage =
  | { type: 'added'; actor: string; targets: string }
  | { type: 'removed'; target: string; actor: string }
  | { type: 'left'; user: string }
  | { type: 'joined'; user: string }
  | { type: 'created'; actor: string; name: string }
  | { type: 'renamed'; actor: string; from: string; to: string }
  | { type: 'topic'; actor: string; topic: string | null };
export function parseSystemMessage(content: string | null): ParsedSystemMessage | null {
  if (!content || !content.startsWith('__system__:')) return null;
  const rest = content.slice('__system__:'.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const event = rest.slice(0, firstColon);
  const json = rest.slice(firstColon + 1);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown, fallback = 'Someone'): string =>
    typeof v === 'string' && v.trim() ? v : fallback;
  if (event === 'added') {
    return { type: 'added', actor: str(payload.actor), targets: str(payload.targets) };
  }
  if (event === 'removed') {
    return { type: 'removed', target: str(payload.target), actor: str(payload.actor) };
  }
  if (event === 'left') {
    return { type: 'left', user: str(payload.user) };
  }
  if (event === 'joined') {
    return { type: 'joined', user: str(payload.user) };
  }
  if (event === 'created') {
    return {
      type: 'created',
      actor: str(payload.actor),
      name: str(payload.name, 'this conversation'),
    };
  }
  if (event === 'renamed') {
    return {
      type: 'renamed',
      actor: str(payload.actor),
      from: str(payload.from, 'Untitled'),
      to: str(payload.to, 'Untitled'),
    };
  }
  if (event === 'topic') {
    const topic = typeof payload.topic === 'string' && payload.topic.trim() ? payload.topic : null;
    return { type: 'topic', actor: str(payload.actor), topic };
  }
  return null;
}

/**
 * Renders a parsed membership system message as the human-readable sentence
 * shown both in the centered chat bubble and OS notification previews, so
 * the two never drift.
 */
export function formatSystemMessage(parsed: ParsedSystemMessage): string {
  switch (parsed.type) {
    case 'added':
      return `${parsed.actor} added ${parsed.targets}`;
    case 'removed':
      return `${parsed.actor} removed ${parsed.target}`;
    case 'left':
      return `${parsed.user} left`;
    case 'joined':
      return `${parsed.user} joined using an invite link`;
    case 'created':
      return `${parsed.actor} created ${parsed.name}`;
    case 'renamed':
      return `${parsed.actor} renamed the conversation from ${parsed.from} to ${parsed.to}`;
    case 'topic':
      return parsed.topic
        ? `${parsed.actor} changed the topic to "${parsed.topic}"`
        : `${parsed.actor} cleared the topic`;
  }
}

export function clearUnread(qc: QueryClient, roomId: string): void {
  qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
    if (!prev) return prev;
    return {
      items: prev.items.map((r) => (r.id === roomId ? { ...r, unreadCount: 0 } : r)),
    };
  });
}
