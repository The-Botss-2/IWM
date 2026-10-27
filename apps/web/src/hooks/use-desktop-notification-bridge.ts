'use client';

import { OS_NOTIFICATION_SOCKET_FEATURE } from '@botss/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { chatServerHasFeature, getChatSocket } from '@/lib/chat-socket';
import { isDesktop, notifyNative } from '@/lib/desktop-runtime';
import { markBellRowSeen, osBannerAllowed } from '@/lib/os-notifications';
import { notificationsKey, useNotifications } from './use-notifications';

/**
 * Entity types whose banner comes from the chat path, never from a bell row:
 * the chat push (or, against an older API, `use-chat-notifications`) covers
 * every message and call. Skipping them here keeps exactly ONE banner per
 * event - never zero, never doubled.
 */
const CHAT_REALTIME_HANDLED = new Set(['chat', 'call']);

/** The API sends desktop banners itself (`os_notification`). */
function serverBanners(): boolean {
  return chatServerHasFeature(OS_NOTIFICATION_SOCKET_FEATURE);
}

interface NotificationEvent {
  id: string;
  title: string;
  body: string;
  url: string | null;
  entityType: string | null;
  entityId: string | null;
}

function bannerFor(n: NotificationEvent): void {
  if (n.entityType && CHAT_REALTIME_HANDLED.has(n.entityType)) return;
  // Against an API that sends `os_notification` the backup follows the same
  // rules as the live banners (Do Not Disturb, the page on screen).
  if (serverBanners() && !osBannerAllowed(n.url, 'generic')) return;
  void notifyNative({
    title: n.title,
    body: n.body,
    ...(n.url ? { url: n.url } : {}),
    // Collapse repeat banners for the same entity, mirroring the tag the
    // server uses for web/native push.
    ...(n.entityType && n.entityId ? { tag: `${n.entityType}:${n.entityId}` } : {}),
  });
}

/**
 * Bell refresh on `notification_created` (every client), plus the desktop
 * banner backup for bell rows.
 *
 * Desktop banners normally come from `os_notification` (`useOsNotifications`),
 * which the API sends with every push a phone gets. Here:
 *
 *  1. Live: against an older API that doesn't advertise `os_notification`,
 *     the desktop app banners straight from `notification_created` as before.
 *  2. Backstop: the bell poll. It keeps running in the background on desktop
 *     (see `useNotifications`) and banners rows the socket missed during a
 *     reconnect. It shares the seen-set with the live banners, so a row is
 *     never bannered twice.
 *
 * Banners are desktop-only.
 */
export function useDesktopNotificationBridge(userId: string | null): void {
  const qc = useQueryClient();
  const { data } = useNotifications();
  const seeded = useRef(false);

  // Live path.
  useEffect(() => {
    if (!userId) return;
    const socket = getChatSocket();
    const onCreated = (n: NotificationEvent) => {
      void qc.invalidateQueries({ queryKey: notificationsKey });
      if (!isDesktop()) return;
      // The server's own `os_notification` banners this row (or, for a chat
      // row, the message push already did). Not marking it seen here keeps
      // that event from being dropped as a repeat.
      if (serverBanners()) return;
      if (!markBellRowSeen(n.id)) return;
      bannerFor(n);
    };
    socket.on('notification_created', onCreated);
    return () => {
      socket.off('notification_created', onCreated);
    };
  }, [userId, qc]);

  // Backstop path.
  useEffect(() => {
    if (!userId || !isDesktop()) return;
    const items = data?.items ?? [];
    if (items.length === 0) return;

    // First populated load: seed the seen-set WITHOUT firing, so reopening
    // the app doesn't replay the whole backlog as a banner storm.
    if (!seeded.current) {
      for (const n of items) markBellRowSeen(n.id);
      seeded.current = true;
      return;
    }

    for (const n of items) {
      if (!markBellRowSeen(n.id)) continue;
      // Don't banner rows already read (e.g. cleared on another device).
      if (n.readAt) continue;
      bannerFor({
        id: n.id,
        title: n.title,
        body: n.body,
        url: n.url ?? null,
        entityType: n.entityType ?? null,
        entityId: n.entityId ?? null,
      });
    }
  }, [userId, data]);
}
