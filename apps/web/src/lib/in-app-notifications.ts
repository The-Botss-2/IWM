'use client';

/**
 * In-app aggregated notification feed.
 *
 * The server-side notifications API (apps/api) currently only persists task
 * and comment events - chat messages and missed calls never reach it. The
 * dashboard bell however should surface "every notification" the user
 * cares about. We mirror chat + call events into this client-side store so
 * the bell's UI doesn't have to know which kind came from where.
 *
 * Storage: a small ring buffer in localStorage keyed by the signed-in
 * user. Survives reloads but never crosses workspaces / sessions. Capped at
 * 100 rows so a chatty week of activity doesn't bloat localStorage.
 *
 * Broadcasting: a custom event lets the bell re-render when a new row
 * lands, without prop drilling through the layout tree. `storage` is also
 * listened to so a second tab sees notifications hit from the first.
 */

const KEY = 'botss.in-app-notifications.v1';
const EVT = 'botss-in-app-notifications';
const MAX = 100;

let cachedNotifications: InAppNotification[] | null = null;

export type InAppKind = 'chat' | 'call-missed' | 'task' | 'comment';

export interface InAppNotification {
  id: string;
  kind: InAppKind;
  title: string;
  body: string;
  url: string;
  createdAt: number;
  readAt: number | null;
  actorImage: string | null;
  actorName: string | null;
}

function safeRead(): InAppNotification[] {
  if (typeof window === 'undefined') return [];
  if (cachedNotifications) return cachedNotifications;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) {
      cachedNotifications = [];
      return cachedNotifications;
    }
    const parsed = JSON.parse(raw) as InAppNotification[];
    cachedNotifications = Array.isArray(parsed) ? parsed : [];
    return cachedNotifications;
  } catch {
    cachedNotifications = [];
    return cachedNotifications;
  }
}

function safeWrite(items: InAppNotification[]): void {
  if (typeof window === 'undefined') return;
  try {
    const sliced = items.slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(sliced));
    cachedNotifications = sliced;
    window.dispatchEvent(new CustomEvent(EVT));
  } catch {
    /* quota exceeded - drop silently, next push trims */
  }
}

export function listInAppNotifications(): InAppNotification[] {
  return safeRead();
}

export function pushInAppNotification(next: InAppNotification): void {
  const all = safeRead();
  // Dedup by id (chat events fire on both `msg_received` and `room_bumped`).
  if (all.some((n) => n.id === next.id)) return;
  safeWrite([next, ...all]);
}

export function markInAppRead(ids: string[]): void {
  const set = new Set(ids);
  const now = Date.now();
  safeWrite(
    safeRead().map((n) => (set.has(n.id) ? { ...n, readAt: n.readAt ?? now } : n)),
  );
}

export function markAllInAppRead(): void {
  const now = Date.now();
  safeWrite(safeRead().map((n) => ({ ...n, readAt: n.readAt ?? now })));
}

export function clearInAppNotifications(ids: string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  safeWrite(safeRead().filter((n) => !set.has(n.id)));
}

export function clearAllInAppNotifications(): void {
  safeWrite([]);
}

export function subscribeInApp(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onChange = () => listener();
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cachedNotifications = null;
      listener();
    }
  };
  window.addEventListener(EVT, onChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVT, onChange);
    window.removeEventListener('storage', onStorage);
  };
}
