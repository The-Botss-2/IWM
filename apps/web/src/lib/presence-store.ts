'use client';

/**
 * Tiny shared presence store. Mirrors the online-user Set produced by
 * `usePresence` so non-React call sites can ask "is user X online right
 * now?" without re-subscribing to the chat socket.
 *
 * `GlobalRealtime` is the sole writer; any number of consumers can read.
 * Listeners are notified on every write so React components can subscribe
 * via `useSyncExternalStore` if they need reactive presence outside the
 * existing `usePresence` hook.
 */

class PresenceStore {
  private onlineIds = new Set<string>();
  private listeners = new Set<() => void>();

  set(next: Set<string>): void {
    this.onlineIds = new Set(next);
    for (const l of this.listeners) l();
  }

  isOnline(userId: string): boolean {
    return this.onlineIds.has(userId);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const presenceStore = new PresenceStore();
