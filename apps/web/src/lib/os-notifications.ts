'use client';

import type { RealtimePushEvent } from '@botss/shared-types';

import { getChatNotifications } from './chat-prefs';
import { type NativeNotification, notifyNative } from './desktop-runtime';

/**
 * Desktop OS banners, decided in one place.
 *
 * The API sends every push it delivers to phones over the chat socket too
 * (`os_notification`, see `NotificationsPushService`), so the desktop app
 * banners exactly the events mobile does. The bell poll is the backup for
 * rows the socket missed. Both go through the dedupe and rules below.
 */

/**
 * Banners already shown (or deliberately skipped). Keys are namespaced:
 * `push:<pushId>`, `n:<notificationId>`, `m:<messageId>`. Module scope so the
 * socket path and the poll backup share it: whichever sees an event first
 * decides, the other skips it.
 */
const seen = new Set<string>();
const SEEN_LIMIT = 2_000;

/** True the first time a key is seen, false on every later call. */
function markSeen(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  // Bounded for a desktop app left open for weeks.
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Mark a bell row as handled. True the first time. */
export function markBellRowSeen(notificationId: string): boolean {
  return markSeen(`n:${notificationId}`);
}

/**
 * The rules every desktop banner follows:
 *  - Do Not Disturb (chat settings) silences everything.
 *  - Nothing is skipped while the window is hidden or unfocused.
 *  - While focused, skip a banner for the page already on screen, and skip
 *    calls (the incoming-call modal is showing).
 */
export function osBannerAllowed(
  url: string | null | undefined,
  type: NativeNotification['type'],
): boolean {
  if (typeof document === 'undefined') return false;
  if (getChatNotifications().doNotDisturb) return false;
  const focused = !document.hidden && document.hasFocus();
  if (!focused) return true;
  if (type === 'call') return false;
  if (!url) return true;
  try {
    return new URL(url, window.location.origin).pathname !== window.location.pathname;
  } catch {
    return true;
  }
}

function dataString(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Banner one `os_notification` from the server, at most once. */
export function showOsNotification(event: RealtimePushEvent): void {
  const notificationId = dataString(event.data, 'notificationId');
  const messageId = dataString(event.data, 'messageId');
  const keys = [
    `push:${event.pushId}`,
    ...(notificationId ? [`n:${notificationId}`] : []),
    ...(messageId ? [`m:${messageId}`] : []),
  ];
  // Mark every key (so the poll backup skips this row too), then bail if
  // any was already handled.
  let fresh = true;
  for (const key of keys) {
    if (!markSeen(key)) fresh = false;
  }
  if (!fresh) return;
  if (!osBannerAllowed(event.url, event.type)) return;
  void notifyNative({
    title: event.title,
    body: event.body,
    url: event.url,
    type: event.type,
    ...(event.tag ? { tag: event.tag } : {}),
  });
}
