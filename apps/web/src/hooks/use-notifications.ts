'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MarkReadByEntityInput, NotificationListResponse } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { isDesktop } from '@/lib/desktop-runtime';

export const notificationsKey = ['notifications', 'list'] as const;

/**
 * Notification bell query. New rows also arrive live over the chat socket
 * (`notification_created`), so this 15 s poll is the backstop. It keeps
 * running while hidden only in the desktop app, where it is the fallback path
 * for OS banners while the window sits in the tray.
 */
export function useNotifications() {
  return useQuery({
    queryKey: notificationsKey,
    queryFn: () => getApi().notifications.list({ limit: 30 }),
    // Ambient bell polled on every page: never toast its load failures (an
    // outage would re-toast every 15 s). The next poll reconciles.
    meta: { silentError: true },
    staleTime: 30_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: isDesktop(),
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getApi().notifications.markRead(id),
    // Fired implicitly on row click / bulk clear; the optimistic unread
    // badge rolls back on failure (onError below), which is feedback enough.
    meta: { silentError: true },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: notificationsKey });
      const previous = qc.getQueryData<NotificationListResponse>(notificationsKey);
      qc.setQueryData<NotificationListResponse>(notificationsKey, (curr) => {
        if (!curr) return curr;
        const wasUnread = curr.items.find((n) => n.id === id && !n.readAt);
        return {
          ...curr,
          items: curr.items.map((n) =>
            n.id === id ? { ...n, readAt: n.readAt ?? new Date() } : n,
          ),
          unreadCount: wasUnread ? Math.max(0, curr.unreadCount - 1) : curr.unreadCount,
        };
      });
      return { previous };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(notificationsKey, ctx.previous);
    },
  });
}

/**
 * Contextual auto-read: clears the caller's unread notifications for an
 * entity the moment they open it, then optimistically updates the bell.
 * Fire it from a route/panel mount with the entity it represents.
 *
 * Pass `null` for entityId to disable (e.g. before the id is known) so the
 * effect can sit unconditionally at the top of a component.
 */
export function useNotificationAutoRead(
  entityType: MarkReadByEntityInput['entityType'],
  entityId: string | null | undefined,
) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;
    void getApi()
      .notifications.markReadByEntity({ entityType, entityId })
      .then(() => {
        if (cancelled) return;
        // Optimistically clear matching rows so the bell updates without
        // waiting for the next 15s poll.
        qc.setQueryData<NotificationListResponse>(notificationsKey, (curr) => {
          if (!curr) return curr;
          const now = new Date();
          let cleared = 0;
          const items = curr.items.map((n) => {
            if (n.entityType === entityType && n.entityId === entityId && !n.readAt) {
              cleared += 1;
              return { ...n, readAt: now };
            }
            return n;
          });
          return { items, unreadCount: Math.max(0, curr.unreadCount - cleared) };
        });
      })
      .catch(() => {
        /* best-effort; the next poll will reconcile */
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId, qc]);
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApi().notifications.markAllRead(),
    meta: { errorTitle: "Couldn't mark notifications as read" },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: notificationsKey });
      const previous = qc.getQueryData<NotificationListResponse>(notificationsKey);
      qc.setQueryData<NotificationListResponse>(notificationsKey, (curr) => {
        if (!curr) return curr;
        const now = new Date();
        return {
          items: curr.items.map((n) => ({ ...n, readAt: n.readAt ?? now })),
          unreadCount: 0,
        };
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(notificationsKey, ctx.previous);
    },
  });
}
