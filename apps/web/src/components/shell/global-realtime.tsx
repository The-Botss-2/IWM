'use client';

import { useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { useCall } from '@/components/chat/call-context';
import { IncomingCallModal } from '@/components/chat/incoming-call-modal';
import { pushInAppNotification, type InAppNotification } from '@/lib/in-app-notifications';
import { useChatRooms } from '@/hooks/use-chat';
import { useChatNotifyingEffects } from '@/hooks/use-chat-notifications';
import { useGlobalChatSocket, usePresence } from '@/hooks/use-chat-socket';
import { useDesktopNotifications } from '@/hooks/use-desktop-notifications';
import { useDesktopNotificationBridge } from '@/hooks/use-desktop-notification-bridge';
import { useNativeNavigation } from '@/hooks/use-native-navigation';
import { useNativePush } from '@/hooks/use-native-push';
import { useOsNotifications } from '@/hooks/use-os-notifications';
import { notificationsKey } from '@/hooks/use-notifications';
import { getChatSocket } from '@/lib/chat-socket';
import type { RoomBumpedPayload } from '@/lib/chat-socket-events';
import { presenceStore } from '@/lib/presence-store';

// LiveKit (`livekit-client`) + the call overlay are heavy and only needed
// once a call starts, so they load on demand instead of shipping in every
// authenticated page's first-load JS. The incoming-call modal stays static
// so ringing shows instantly.
const ActiveCallSurface = dynamic(() => import('@/components/shell/active-call-surface'), {
  ssr: false,
});

/**
 * Mounted once at the authenticated app-shell level. Owns every piece of
 * real-time plumbing that needs to outlive any single page:
 *
 *   - The chat WebSocket connection (so message + call events deliver while
 *     the user is on /dashboard, /projects, anywhere - not only /chat).
 *   - Presence broadcasts (powers the call-target-online check and online
 *     avatar dots across the app).
 *   - Native OS push subscription (registers the service worker).
 *   - The in-app + OS notification dispatcher (chat messages, calls).
 *   - The incoming-call modal and the active-call overlay, both rendered
 *     into a portal-style fixed layer so they appear on every route.
 *   - The aggregated notification feed (chat / call / task) fed into the
 *     dashboard bell via `pushInAppNotification`.
 *
 * Renders just the call surfaces - there's no other UI here.
 */
export function GlobalRealtime() {
  const session = useSessionContext();
  const userId = session.data?.user?.id ?? '';

  // Chat rooms power the notification title-derivation ("Sara in #ops")
  // and the active-call peer name lookup.
  const { data: roomsData } = useChatRooms();
  const rooms = useMemo(() => roomsData?.items ?? [], [roomsData]);

  useGlobalChatSocket(userId);
  const presenceSet = usePresence(userId);
  useDesktopNotifications(userId || null);
  // Desktop OS banners: the server sends every push a phone gets (bell rows,
  // chat messages, calls) over the socket too. No-op on browser/mobile.
  useOsNotifications(userId || null);
  // Live bell refresh everywhere, plus the desktop banner backup off the bell
  // poll for rows the socket missed.
  useDesktopNotificationBridge(userId || null);
  // Register the native mobile push token (injected by the Expo WebView shell)
  // against this session. No-op on browser/desktop.
  useNativePush(Boolean(userId));
  // Route notification taps from the mobile and desktop shells client-side.
  useNativeNavigation(Boolean(userId));

  // Mirror the presence Set into a module-level store so non-React call
  // sites (e.g. ChatWindow's "is the peer online?" check) can read it
  // without re-subscribing to the socket.
  useEffect(() => {
    presenceStore.set(presenceSet);
  }, [presenceSet]);

  const qc = useQueryClient();
  const call = useCall();

  useChatNotifyingEffects({ selfUserId: userId, rooms, callPhase: call.phase });

  // ---- Aggregate feed for the bell ------------------------------------
  // The server-side notifications API only emits task/comment rows today.
  // We mirror chat-message and call events into the same bell so the user
  // sees "every notification" from one place, as requested. The mirror is
  // kept in-memory + localStorage via `lib/in-app-notifications`.

  // Coalesces the "new message arrived, re-read the bell" nudges. A burst of
  // messages produces ONE refetch, not one per message.
  const bellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBellRefresh = useCallback(() => {
    if (bellTimerRef.current) return;
    bellTimerRef.current = setTimeout(() => {
      bellTimerRef.current = null;
      void qc.invalidateQueries({ queryKey: notificationsKey });
    }, 1_500);
  }, [qc]);

  useEffect(() => {
    if (!userId) return;

    /**
     * One socket message can match two notification shapes - a regular
     * chat message or a missed/declined-call log. The chat server stores
     * call outcomes as messages whose `content` carries a `__call__:STATUS:…`
     * marker, so the same socket event drives both feed types. We branch
     * on the marker here.
     */
    const handleSocketMessage = (raw: {
      id: string;
      roomId: string;
      senderId: string;
      content: string | null;
    }) => {
      if (raw.senderId === userId) return;
      const room = rooms.find((r) => r.id === raw.roomId);
      const sender = room?.participants.find((p) => p.userId === raw.senderId);
      const senderName = sender?.user.name ?? sender?.user.email ?? 'Someone';

      if (raw.content && raw.content.startsWith('__call__:')) {
        const status = raw.content.split(':')[1];
        if (status === 'MISSED' || status === 'REJECTED') {
          const notification: InAppNotification = {
            id: `call-missed:${raw.id}`,
            kind: 'call-missed',
            title: status === 'MISSED' ? 'Missed call' : 'Call declined',
            body: `${senderName} ${status === 'MISSED' ? 'tried to reach you' : 'declined the call'}.`,
            url: `/chat/${raw.roomId}`,
            createdAt: Date.now(),
            readAt: null,
            actorImage: sender?.user.image ?? null,
            actorName: senderName,
          };
          pushInAppNotification(notification);
        }
        return;
      }

      // Regular chat messages are emitted as server-side notification rows by
      // chat.service.ts (fanoutMessageBell) and surface in the bell from there.
      // Mirroring them into the in-app feed too produced DUPLICATE bell rows,
      // and those mirror rows never cleared (the server's entity-auto-read on
      // chat open can't touch localStorage). So we only mirror missed/declined
      // calls here - the server doesn't record those yet.
      //
      // What we DO is nudge the bell query. The row is written by a
      // fire-and-forget fan-out that races this socket event, so a short
      // delay before refetching is deliberate - without it the request can
      // land before the row exists and the badge sits stale for the rest of
      // the 15s poll interval.
      scheduleBellRefresh();
    };

    const socket = getChatSocket();
    const onBumped = (p: RoomBumpedPayload) => handleSocketMessage(p.lastMessage);
    socket.on('room_bumped', onBumped);
    return () => {
      socket.off('room_bumped', onBumped);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, userId, qc]);

  // Cancel a pending bell refresh on UNMOUNT only. This deliberately does not
  // live in the effect above: that one re-runs whenever `rooms` changes, and
  // `bumpRoom` changes `rooms` on every incoming message - so clearing the
  // timer there would cancel the very refresh the message just scheduled.
  useEffect(
    () => () => {
      if (bellTimerRef.current) clearTimeout(bellTimerRef.current);
      bellTimerRef.current = null;
    },
    [],
  );

  // ---- Incoming-call modal data ---------------------------------------

  const incomingRoom = useMemo(
    () => (call.incoming ? rooms.find((r) => r.id === call.incoming!.roomId) : null),
    [call.incoming, rooms],
  );
  const incomingCallerName = useMemo(() => {
    if (!call.incoming || !incomingRoom) return 'Unknown';
    const caller = incomingRoom.participants.find((p) => p.userId === call.incoming!.callerId);
    return caller?.user.name ?? caller?.user.email ?? 'Unknown';
  }, [call.incoming, incomingRoom]);
  const incomingCallerImage = useMemo(() => {
    if (!call.incoming || !incomingRoom) return null;
    const caller = incomingRoom.participants.find((p) => p.userId === call.incoming!.callerId);
    return caller?.user.image ?? null;
  }, [call.incoming, incomingRoom]);

  return (
    <>
      {call.phase === 'incoming' && call.incoming ? (
        <IncomingCallModal
          callerName={incomingCallerName}
          callerImage={incomingCallerImage}
          onAccept={call.acceptIncoming}
          onDecline={call.declineIncoming}
        />
      ) : null}

      {call.phase === 'outgoing' || call.phase === 'connecting' || call.phase === 'connected' ? (
        <ActiveCallSurface rooms={rooms} userId={userId} presenceSet={presenceSet} />
      ) : null}
    </>
  );
}
