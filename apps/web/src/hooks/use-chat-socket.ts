'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ChatRoomMessage } from '@botss/shared-types';

import {
  appendIncomingRoomMessage,
  applyMessageUpdate,
  applyReactionUpdate,
  applyStatusUpdate,
  bumpRoom,
  chatRoomsKey,
  clearUnread,
} from '@/hooks/use-chat';
import { chatRequestsIncomingKey, chatRequestsOutgoingKey } from '@/hooks/use-chat-requests';
import { getChatSocket } from '@/lib/chat-socket';
import type {
  MsgStatusUpdatePayload,
  NotificationCreatedPayload,
  RoomBumpedPayload,
} from '@/lib/chat-socket-events';

export function useRoomRealtime(roomId: string | null, selfUserId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!roomId) return;
    const socket = getChatSocket();
    const join = () => socket.emit('join_room', { roomId });
    if (socket.connected) join();
    else socket.once('connect', join);

    const onMessage = (raw: ChatRoomMessage & { clientNonce?: string | null }) => {
      if (raw.roomId !== roomId) return;
      appendIncomingRoomMessage(qc, roomId, raw);
      if (raw.senderId !== selfUserId) {
        socket.emit('mark_read', { roomId, upToMessageId: raw.id });
      }
    };
    const onStatus = (payload: MsgStatusUpdatePayload) => {
      if (payload.roomId !== roomId) return;
      applyStatusUpdate(
        qc,
        roomId,
        payload.status,
        payload.messageIds,
        payload.byUserId === selfUserId,
      );
    };

    const onReaction = (payload: {
      messageId: string;
      roomId: string;
      reactions: { emoji: string; count: number; reactedByMe: boolean; userIds: string[] }[];
    }) => {
      if (payload.roomId !== roomId) return;
      applyReactionUpdate(qc, roomId, payload.messageId, payload.reactions);
    };

    const onUpdated = (raw: ChatRoomMessage) => {
      if (raw.roomId !== roomId) return;
      applyMessageUpdate(qc, roomId, raw);
    };

    socket.on('msg_received', onMessage);
    socket.on('msg_status_update', onStatus);
    socket.on('reaction_update', onReaction);
    socket.on('msg_updated', onUpdated);

    return () => {
      socket.off('msg_received', onMessage);
      socket.off('msg_status_update', onStatus);
      socket.off('reaction_update', onReaction);
      socket.off('msg_updated', onUpdated);
      socket.emit('leave_room', { roomId });
    };
  }, [roomId, qc, selfUserId]);
}

export function usePresence(selfUserId: string) {
  const [onlineSet, setOnlineSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!selfUserId) return;
    const socket = getChatSocket();
    const onConnected = (payload: { userId: string; onlineUserIds?: string[] }) => {
      if (payload.onlineUserIds) setOnlineSet(new Set(payload.onlineUserIds));
    };
    const onPresence = (payload: { userId: string; online: boolean }) => {
      setOnlineSet((prev) => {
        const next = new Set(prev);
        if (payload.online) next.add(payload.userId);
        else next.delete(payload.userId);
        return next;
      });
    };
    socket.on('connected', onConnected);
    socket.on('presence_update', onPresence);
    return () => {
      socket.off('connected', onConnected);
      socket.off('presence_update', onPresence);
    };
  }, [selfUserId]);
  return onlineSet;
}

export function useGlobalChatSocket(selfUserId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!selfUserId) return;
    const socket = getChatSocket();

    const onRoomBumped = (payload: RoomBumpedPayload) => {
      const isSelf = payload.lastMessage.senderId === selfUserId;
      const applied = bumpRoom(qc, payload.roomId, payload.lastMessage, isSelf);
      // Only round-trip when the room isn't in the cached list yet (a new DM,
      // or a channel we were just added to). Refetching on EVERY message made
      // a busy channel issue one full room-list query per message, and the
      // response landing after the local re-sort produced a visible flicker.
      if (!applied) void qc.invalidateQueries({ queryKey: chatRoomsKey });
    };

    // Global listener so the sidebar badge clears even when the user
    // marks a room as read from the sidebar context menu without the
    // chat-window mounted (no useRoomRealtime to catch the event).
    const onStatus = (payload: MsgStatusUpdatePayload) => {
      if (payload.status === 'READ' && payload.byUserId === selfUserId) {
        clearUnread(qc, payload.roomId);
      }
    };

    // A chat request reached us, or one we sent was accepted: refresh both
    // request lists. Neither is edited in place by a component (accept,
    // decline and cancel patch them optimistically), so a refetch is safe and
    // keeps Settings from offering "Cancel" on a request that was accepted.
    const onNotification = (payload: NotificationCreatedPayload) => {
      if (payload.type !== 'CHAT_REQUEST' && payload.entityType !== 'chat_request') return;
      void qc.invalidateQueries({ queryKey: chatRequestsIncomingKey });
      void qc.invalidateQueries({ queryKey: chatRequestsOutgoingKey });
    };

    socket.on('room_bumped', onRoomBumped);
    socket.on('msg_status_update', onStatus);
    socket.on('notification_created', onNotification);
    return () => {
      socket.off('room_bumped', onRoomBumped);
      socket.off('msg_status_update', onStatus);
      socket.off('notification_created', onNotification);
    };
  }, [qc, selfUserId]);
}
