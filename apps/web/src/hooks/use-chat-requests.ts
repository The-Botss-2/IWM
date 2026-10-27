'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CHAT_REQUEST_MESSAGE_MAX, createChatRequestSchema } from '@botss/shared-types';
import type {
  ChatRequestBlockList,
  ChatRoomListResponse,
  ChatRoomSummary,
  CreateChatRequestInput,
  IncomingChatRequest,
  IncomingChatRequestList,
  OutgoingChatRequestList,
} from '@botss/shared-types';

import { chatRoomsKey } from '@/hooks/use-chat';
import { getApi } from '@/lib/api';
import { toastSuccess } from '@/lib/toast';

/**
 * Cross-organization chat requests. Every mutation patches its list in place
 * (optimistic where the outcome is known up front) and rolls back on error;
 * nothing here refetches after a mutation. The one invalidation is the live
 * `notification_created` handler in useGlobalChatSocket, on the incoming
 * list, which no component edits in place.
 */
export const chatRequestsIncomingKey = ['chat', 'requests', 'incoming'] as const;
export const chatRequestsOutgoingKey = ['chat', 'requests', 'outgoing'] as const;
export const chatRequestBlocksKey = ['chat', 'requests', 'blocks'] as const;

export function useIncomingChatRequests(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: chatRequestsIncomingKey,
    queryFn: () => getApi().chat.listIncomingRequests(),
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
}

export function useOutgoingChatRequests() {
  return useQuery({
    queryKey: chatRequestsOutgoingKey,
    queryFn: () => getApi().chat.listOutgoingRequests(),
    staleTime: 60_000,
  });
}

export function useChatRequestBlocks(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: chatRequestBlocksKey,
    queryFn: () => getApi().chat.listRequestBlocks(),
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  });
}

/** Block the other person in a cross-organization DM. They can no longer
 *  message, call or send requests; they aren't told. */
export function useBlockChatUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't block this person" },
    mutationFn: (user: ChatRequestBlockList['items'][number]['user']) =>
      getApi().chat.blockUser(user.id),
    onMutate: async (user) => {
      await qc.cancelQueries({ queryKey: chatRequestBlocksKey });
      const previous = qc.getQueryData<ChatRequestBlockList>(chatRequestBlocksKey);
      qc.setQueryData<ChatRequestBlockList | undefined>(chatRequestBlocksKey, (prev) => {
        if (!prev || prev.items.some((b) => b.user.id === user.id)) return prev;
        return { items: [{ user, blockedAt: new Date() }, ...prev.items] };
      });
      return { previous };
    },
    onError: (_err, _user, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRequestBlocksKey, ctx.previous);
    },
    onSuccess: (block) => {
      qc.setQueryData<ChatRequestBlockList | undefined>(chatRequestBlocksKey, (prev) =>
        prev
          ? { items: prev.items.map((b) => (b.user.id === block.user.id ? block : b)) }
          : prev,
      );
    },
  });
}

/**
 * Send a request. The server answers the same notice for every address, so
 * there is nothing to predict optimistically: the returned row goes to the
 * top of the outgoing list (replacing an earlier row for the same address).
 */
export function useSendChatRequest() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't send chat request" },
    mutationFn: (input: CreateChatRequestInput) => getApi().chat.sendRequest(input),
    onSuccess: (res) => {
      qc.setQueryData<OutgoingChatRequestList | undefined>(chatRequestsOutgoingKey, (prev) => {
        if (!prev) return prev;
        return {
          items: [res.request, ...prev.items.filter((r) => r.id !== res.request.id)],
        };
      });
      toastSuccess(res.notice);
    },
  });
}

/** Accept: drop it from the incoming list now, add the DM to the room list
 *  (as useCreateChatRoom does) and open it. */
export function useAcceptChatRequest() {
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    meta: { errorTitle: "Couldn't accept chat request" },
    mutationFn: (requestId: string) => getApi().chat.acceptRequest(requestId),
    onMutate: async (requestId: string) => {
      await qc.cancelQueries({ queryKey: chatRequestsIncomingKey });
      const previous = qc.getQueryData<IncomingChatRequestList>(chatRequestsIncomingKey);
      qc.setQueryData<IncomingChatRequestList | undefined>(chatRequestsIncomingKey, (prev) =>
        prev ? { items: prev.items.filter((r) => r.id !== requestId) } : prev,
      );
      return { previous };
    },
    onError: (_err, _requestId, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRequestsIncomingKey, ctx.previous);
    },
    onSuccess: (room: ChatRoomSummary) => {
      qc.setQueryData<ChatRoomListResponse | undefined>(chatRoomsKey, (prev) => {
        if (!prev) return { items: [room] };
        if (prev.items.some((r) => r.id === room.id)) return prev;
        return { items: [room, ...prev.items] };
      });
      router.push(`/chat/${room.id}`);
    },
  });
}

/** Decline, or decline and block (which also hides every other request
 *  from the same person). */
export function useDeclineChatRequest() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't decline chat request" },
    mutationFn: (args: { request: IncomingChatRequest; block: boolean }) =>
      getApi().chat.declineRequest(args.request.id, { block: args.block }),
    onMutate: async ({ request, block }) => {
      await qc.cancelQueries({ queryKey: chatRequestsIncomingKey });
      const previous = qc.getQueryData<IncomingChatRequestList>(chatRequestsIncomingKey);
      qc.setQueryData<IncomingChatRequestList | undefined>(chatRequestsIncomingKey, (prev) =>
        prev
          ? {
              items: prev.items.filter((r) =>
                block ? r.requester.id !== request.requester.id : r.id !== request.id,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onError: (_err, _args, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRequestsIncomingKey, ctx.previous);
    },
    onSuccess: (_res, { request, block }) => {
      if (!block) return;
      const { id, name, email, image } = request.requester;
      qc.setQueryData<ChatRequestBlockList | undefined>(chatRequestBlocksKey, (prev) => {
        if (!prev || prev.items.some((b) => b.user.id === id)) return prev;
        return { items: [{ user: { id, name, email, image }, blockedAt: new Date() }, ...prev.items] };
      });
    },
  });
}

/** Withdraw a sent request: it stays in the list, marked cancelled. */
export function useCancelChatRequest() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't cancel chat request" },
    mutationFn: (requestId: string) => getApi().chat.cancelRequest(requestId),
    onMutate: async (requestId: string) => {
      await qc.cancelQueries({ queryKey: chatRequestsOutgoingKey });
      const previous = qc.getQueryData<OutgoingChatRequestList>(chatRequestsOutgoingKey);
      qc.setQueryData<OutgoingChatRequestList | undefined>(chatRequestsOutgoingKey, (prev) =>
        prev
          ? {
              items: prev.items.map((r) =>
                r.id === requestId ? { ...r, state: 'CANCELLED' as const } : r,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onError: (_err, _requestId, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRequestsOutgoingKey, ctx.previous);
    },
  });
}

export function useUnblockChatRequester() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't unblock" },
    mutationFn: (userId: string) => getApi().chat.unblockRequester(userId),
    onMutate: async (userId: string) => {
      await qc.cancelQueries({ queryKey: chatRequestBlocksKey });
      const previous = qc.getQueryData<ChatRequestBlockList>(chatRequestBlocksKey);
      qc.setQueryData<ChatRequestBlockList | undefined>(chatRequestBlocksKey, (prev) =>
        prev ? { items: prev.items.filter((b) => b.user.id !== userId) } : prev,
      );
      return { previous };
    },
    onError: (_err, _userId, ctx) => {
      if (ctx?.previous) qc.setQueryData(chatRequestBlocksKey, ctx.previous);
    },
  });
}

/**
 * Block / unblock for the DM header. Only active for a DM that spans
 * organizations (opened from an accepted chat request); returns null
 * otherwise so the header shows nothing.
 */
export function useCrossOrgDmBlock(room: ChatRoomSummary, currentUserId: string) {
  const active = room.type === 'DM' && room.spansOrganizations === true;
  const blocks = useChatRequestBlocks({ enabled: active });
  const block = useBlockChatUser();
  const unblock = useUnblockChatRequester();
  const peer = active ? room.participants.find((p) => p.userId !== currentUserId)?.user : undefined;
  if (!peer) return null;
  return {
    peer,
    blocked: (blocks.data?.items ?? []).some((b) => b.user.id === peer.id),
    ready: blocks.isSuccess,
    pending: block.isPending || unblock.isPending,
    block: () => block.mutateAsync(peer),
    unblock: () => unblock.mutate(peer.id),
  };
}

/**
 * State + validation for the "Send a chat request" dialog. Validation is the
 * shared `createChatRequestSchema` (the same one the API applies), so the
 * Send button enables exactly when the server would accept the input.
 */
export function useChatRequestForm() {
  const send = useSendChatRequest();
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = createChatRequestSchema.safeParse({ email, message });

  function reset(): void {
    setEmail('');
    setMessage('');
    setNotice(null);
    send.reset();
  }

  function submit(): void {
    if (!parsed.success || send.isPending) return;
    send.mutate(parsed.data, { onSuccess: (res) => setNotice(res.notice) });
  }

  return {
    email,
    setEmail,
    message,
    setMessage,
    notice,
    canSend: parsed.success,
    tooLong: message.length > CHAT_REQUEST_MESSAGE_MAX,
    pending: send.isPending,
    submit,
    reset,
  };
}
