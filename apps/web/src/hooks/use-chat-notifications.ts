'use client';

import { useEffect, useMemo, useRef } from 'react';
import {
  type ChatRoomMessage,
  type ChatRoomSummary,
  OS_NOTIFICATION_SOCKET_FEATURE,
} from '@botss/shared-types';

import { getChatNotifications } from '@/lib/chat-prefs';
import {
  RingLoop,
  playMessageBlip,
} from '@/lib/chat-sounds';
import { chatServerHasFeature, getChatSocket } from '@/lib/chat-socket';
import type { RoomBumpedPayload } from '@/lib/chat-socket-events';
import { isDesktop, notifyNative } from '@/lib/desktop-runtime';
import { formatSystemMessage, parseSystemMessage } from './use-chat';

interface Args {
  selfUserId: string;
  rooms: ChatRoomSummary[];
  callPhase: 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'connected';
}

const TITLE_BASE_KEY = 'botss.chat.title-base';

function readBaseTitle(): string {
  if (typeof document === 'undefined') return '';
  const stored = window.sessionStorage.getItem(TITLE_BASE_KEY);
  if (stored) return stored;
  const base = document.title.replace(/^\(\d+(\+)?\)\s*/, '');
  window.sessionStorage.setItem(TITLE_BASE_KEY, base);
  return base;
}

export function useChatNotifyingEffects({ selfUserId, rooms, callPhase }: Args) {
  const ringRef = useRef<RingLoop | null>(null);

  const totalUnread = useMemo(
    () => rooms.reduce((acc, r) => acc + (r.unreadCount ?? 0), 0),
    [rooms],
  );

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = readBaseTitle();
    if (totalUnread > 0) {
      const badge = totalUnread > 99 ? '99+' : totalUnread.toString();
      document.title = `(${badge}) ${base}`;
    } else {
      document.title = base;
    }
  }, [totalUnread]);

  useEffect(() => {
    if (!selfUserId) return;
    const socket = getChatSocket();
    // De-dupe across both events: `msg_received` only fires when the viewer
    // is in the chat's socket-room (open chat page), while `room_bumped`
    // reliably reaches everywhere the user is connected. Listening to both
    // means the sound plays for the active room AND for messages from any
    // other room.
    const recentlyPlayed = new Set<string>();
    /**
     * Decide whether this message should notify, and play the sound if the
     * user wants one. The OS banner is decoupled from the sound: muting the
     * message sound used to silently disable desktop banners for chat too.
     * Only Do Not Disturb suppresses both.
     */
    function shouldBlip(messageId: string, senderId: string): boolean {
      if (senderId === selfUserId) return false;
      if (recentlyPlayed.has(messageId)) return false;
      recentlyPlayed.add(messageId);
      // Keep the set small. 200ms is plenty to absorb the two events.
      setTimeout(() => recentlyPlayed.delete(messageId), 2_000);
      const prefs = getChatNotifications();
      if (prefs.doNotDisturb) return false;
      if (prefs.messageSound) playMessageBlip(prefs.volume);
      return true;
    }
    const onMessage = (raw: ChatRoomMessage & { clientNonce?: string | null }) => {
      const played = shouldBlip(raw.id, raw.senderId);
      if (played) {
        const room = rooms.find((r) => r.id === raw.roomId);
        showLocalNotification({
          title: deriveTitle(room, raw.senderId, selfUserId),
          body: previewMessageBody(raw),
          tag: `chat:${raw.roomId}`,
          url: `/chat/${raw.roomId}`,
        });
      }
    };
    const onBumped = (payload: RoomBumpedPayload) => {
      const played = shouldBlip(payload.lastMessage.id, payload.lastMessage.senderId);
      if (played) {
        const room = rooms.find((r) => r.id === payload.roomId);
        showLocalNotification({
          title: deriveTitle(room, payload.lastMessage.senderId, selfUserId),
          body: previewMessageBody(payload.lastMessage),
          tag: `chat:${payload.roomId}`,
          url: `/chat/${payload.roomId}`,
        });
      }
    };
    socket.on('msg_received', onMessage);
    socket.on('room_bumped', onBumped);
    return () => {
      socket.off('msg_received', onMessage);
      socket.off('room_bumped', onBumped);
    };
  }, [rooms, selfUserId]);

  useEffect(() => {
    if (callPhase !== 'incoming') {
      ringRef.current?.stop();
      ringRef.current = null;
      return;
    }
    const prefs = getChatNotifications();
    if (prefs.doNotDisturb) return;
    if (!prefs.callSound) return;
    // Slack-style OS popup for the call - fires immediately when the
    // tab isn't focused. The in-app `IncomingCallModal` covers the
    // focused-tab case. (The desktop app's call pop-up comes from the
    // server's `os_notification` instead, whatever the call sound setting.)
    showLocalNotification({
      title: 'Incoming call',
      body: 'Click to answer.',
      tag: 'incoming-call',
      // Sticky so it stays until the user reacts - matches the
      // requireInteraction contract the Web Push path uses.
      requireInteraction: true,
    });
    const loop = new RingLoop();
    loop.start(prefs.volume);
    ringRef.current = loop;
    // Hard ceiling - even if `callPhase` never transitions away from
    // 'incoming' (e.g. a stuck socket), the user shouldn't endure an
    // unending ringtone. 50s is just past the auto-decline timeout in
    // use-whatsapp-call so under normal conditions this never fires.
    const guard = setTimeout(() => {
      loop.stop();
      ringRef.current = null;
    }, 50_000);
    return () => {
      clearTimeout(guard);
      loop.stop();
      ringRef.current = null;
    };
  }, [callPhase]);
}

/**
 * Show a native OS notification banner. Routes through the registered
 * service worker's `showNotification` API when one is active, falling
 * back to the in-tab `new Notification()` constructor otherwise.
 *
 * The SW route matters because **Chrome throttles in-tab JavaScript
 * (including `new Notification()`) when the tab has been backgrounded
 * for several minutes**. The service worker runs in a separate context
 * that isn't throttled, so notifications sourced from it still surface
 * to the user even while the tab is fully idle. This is the same
 * mechanism Web Push relies on; we just call it ourselves instead of
 * round-tripping through a push provider.
 *
 * Suppresses itself when the tab is focused - no point banner-spamming
 * a user who's already looking at the app.
 */
function showLocalNotification(args: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  requireInteraction?: boolean;
}): void {
  if (typeof window === 'undefined') return;
  if (typeof document === 'undefined') return;
  // If the user is actively looking at the tab, the in-app row + sound
  // are enough; an OS popup on top is annoying.
  if (!document.hidden && document.hasFocus()) return;

  // Desktop client path. Native Action Center banner via the Electron bridge
  // - survives the window being minimised in a way the browser path can't
  // always guarantee. Against an API that sends `os_notification` the server
  // banners every message and call itself (`useOsNotifications`, the same
  // events a phone gets a push for), so this path only keeps the sounds.
  if (isDesktop()) {
    if (chatServerHasFeature(OS_NOTIFICATION_SOCKET_FEATURE)) return;
    void notifyNative({
      title: args.title,
      body: args.body,
      ...(args.tag ? { tag: args.tag } : {}),
      ...(args.url ? { url: args.url } : {}),
    });
    return;
  }

  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') {
    // console.debug => Chrome "Verbose" level (hidden by default), so this
    // is silent in normal use but available when diagnosing "no banner".
    // eslint-disable-next-line no-console
    console.debug('[notify] suppressed - Notification.permission =', Notification.permission);
    return;
  }

  const options: NotificationOptions = {
    body: args.body,
    tag: args.tag,
    requireInteraction: args.requireInteraction ?? false,
    icon: '/branding/icon-192.png',
    badge: '/branding/badge-72.png',
    // `data` is round-tripped to the SW click handler so it can open
    // the right page when the user clicks the banner.
    ...(args.url ? { data: { url: args.url } } : {}),
  } as NotificationOptions;

  // Preferred path: ask the registered service worker to show the
  // notification - ServiceWorkerRegistration.showNotification keeps working
  // even when the originating tab is throttled in the background.
  //
  // IMPORTANT: do NOT block on `navigator.serviceWorker.ready`. Per spec
  // that promise only resolves once the origin has an active worker and
  // never rejects, so if no SW is registered (e.g. push/VAPID isn't
  // configured) it stays pending forever and BOTH the SW call and the
  // fallback below would never run. `getRegistration()` resolves promptly
  // to the registration or `undefined`, so we branch without ever hanging.
  const sw = navigator.serviceWorker;
  if (sw && typeof sw.getRegistration === 'function') {
    sw.getRegistration()
      .then((reg) => {
        if (reg && reg.active) {
          return reg.showNotification(args.title, options);
        }
        // No active worker yet (first load before activation, or none
        // registered at all) - use the in-tab constructor instead.
        tryDirectNotification(args, options);
        return undefined;
      })
      .catch(() => tryDirectNotification(args, options));
    return;
  }
  tryDirectNotification(args, options);
}

function tryDirectNotification(
  args: { title: string; url?: string },
  options: NotificationOptions,
): void {
  try {
    const n = new Notification(args.title, options);
    if (args.url) {
      n.onclick = () => {
        try {
          window.focus();
        } catch {
          /* focus blocked */
        }
        if (args.url) window.location.href = args.url;
        n.close();
      };
    }
  } catch {
    // Some browsers reject Notification() outside a user gesture even
    // with permission granted (Safari quirks). Silent fail - the in-app
    // sound + row still happened.
  }
}

function deriveTitle(
  room: ChatRoomSummary | undefined,
  senderId: string,
  selfUserId: string,
): string {
  if (!room) return 'New message';
  if (room.type === 'DM') {
    const peer = room.participants.find((p) => p.userId !== selfUserId);
    return peer?.user.name ?? peer?.user.email ?? 'New message';
  }
  const sender = room.participants.find((p) => p.userId === senderId);
  const senderName = sender?.user.name ?? sender?.user.email ?? 'Someone';
  const roomLabel = room.name ?? 'Group';
  return `${senderName} in ${roomLabel}`;
}

function previewMessageBody(m: ChatRoomMessage): string {
  // Call-log + share-card messages have markers as content - render the
  // human-readable form instead of leaking `__call__:` text into the
  // OS banner.
  if (!m.content) return '[attachment]';
  if (m.content.startsWith('__call__:')) {
    const parts = m.content.split(':');
    const status = parts[1];
    if (status === 'MISSED') return 'Missed call';
    if (status === 'REJECTED') return 'Call declined';
    return 'Call ended';
  }
  if (m.content.startsWith('__share__:')) return 'Shared an item';
  const sys = parseSystemMessage(m.content);
  if (sys) return formatSystemMessage(sys);
  return m.content.slice(0, 200);
}
