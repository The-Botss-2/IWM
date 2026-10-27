'use client';

import { useSyncExternalStore } from 'react';

/**
 * Connection state of the chat socket (`lib/chat-socket.ts`), module-level so
 * the shell's connection banner can show "Reconnecting…" without threading
 * props through the app. Mirrors `lib/mail-stream-status.ts`.
 *
 * - `connecting`   first connect in progress (no banner)
 * - `live`         connected
 * - `reconnecting` dropped; socket.io (or our retry) is trying again
 * - `offline`      dropped and nothing will retry until a reload
 */
export type ChatConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

let state: ChatConnectionState = 'connecting';
const listeners = new Set<() => void>();

export function setChatConnectionState(next: ChatConnectionState): void {
  if (state === next) return;
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChatConnectionState(): ChatConnectionState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => 'connecting',
  );
}
