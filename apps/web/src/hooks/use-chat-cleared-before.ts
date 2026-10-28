'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * "Clear chat for me" - per-room timestamp; any message with
 * `createdAt < clearedBefore` is hidden from this user's view, without
 * touching the server. Stored locally so it doesn't sync across devices,
 * matching the WhatsApp "Clear chat" affordance.
 */
function keyFor(userId: string): string {
  return `chat_cleared_before_${userId}`;
}

type ClearedMap = Record<string, number>; // roomId -> epoch ms

function read(userId: string): ClearedMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ClearedMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function write(userId: string, map: ClearedMap): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(keyFor(userId), JSON.stringify(map));
}

const EVT = 'botss-chat-cleared-before';

export function useChatClearedBefore(userId: string): {
  clearedBefore: (roomId: string) => number | null;
  clearRoom: (roomId: string, at?: Date) => void;
  resetRoom: (roomId: string) => void;
} {
  const [map, setMap] = useState<ClearedMap>({});

  useEffect(() => {
    if (!userId) return;
    setMap(read(userId));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<ClearedMap>).detail;
      if (detail) setMap(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(userId)) setMap(read(userId));
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  const clearedBefore = useCallback((roomId: string) => map[roomId] ?? null, [map]);

  const clearRoom = useCallback(
    (roomId: string, at: Date = new Date()) => {
      setMap((prev) => {
        const next = { ...prev, [roomId]: at.getTime() };
        if (userId) write(userId, next);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
        }
        return next;
      });
    },
    [userId],
  );

  const resetRoom = useCallback(
    (roomId: string) => {
      setMap((prev) => {
        if (!(roomId in prev)) return prev;
        const next = { ...prev };
        delete next[roomId];
        if (userId) write(userId, next);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
        }
        return next;
      });
    },
    [userId],
  );

  return { clearedBefore, clearRoom, resetRoom };
}
