'use client';

import { useEffect } from 'react';
import { realtimePushEventSchema } from '@botss/shared-types';

import { getChatSocket } from '@/lib/chat-socket';
import { isDesktop } from '@/lib/desktop-runtime';
import { showOsNotification } from '@/lib/os-notifications';

/**
 * Desktop OS banners from the server's `os_notification` socket event: the
 * same payload, sent at the same moment, as the push a phone gets for a bell
 * row, a chat message or an incoming call. The socket stays connected while
 * the window sits in the tray, so banners keep coming. Rules and dedupe live
 * in `lib/os-notifications`. No-op outside the desktop app (browsers get Web
 * Push, phones native push).
 */
export function useOsNotifications(userId: string | null): void {
  useEffect(() => {
    if (!userId || !isDesktop()) return;
    const socket = getChatSocket();
    const onPush = (raw: unknown) => {
      const parsed = realtimePushEventSchema.safeParse(raw);
      if (!parsed.success) return;
      showOsNotification(parsed.data);
    };
    socket.on('os_notification', onPush);
    return () => {
      socket.off('os_notification', onPush);
    };
  }, [userId]);
}
