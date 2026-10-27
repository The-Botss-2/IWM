'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the mail SSE stream (`useMailEvents`) is currently connected.
 * Module-level so the mail queries can slow their fallback polling while
 * push updates are flowing, without threading props through the mail page.
 *
 * Also tracked as a tri-state for the shell's connection banner:
 * - `connecting`   no stream yet (or the mail page is not mounted)
 * - `live`         connected
 * - `reconnecting` it was open and dropped; EventSource is retrying
 */
export type MailStreamState = 'connecting' | 'live' | 'reconnecting';

let state: MailStreamState = 'connecting';
const listeners = new Set<() => void>();

function setState(next: MailStreamState): void {
  if (state === next) return;
  state = next;
  for (const l of listeners) l();
}

export function setMailStreamLive(next: boolean): void {
  if (next) setState('live');
  // Only a stream that was open can be "reconnecting"; an initial failure
  // stays `connecting` (the fast fallback poll covers it either way).
  else if (state === 'live') setState('reconnecting');
}

/** The stream was closed on purpose (mail page unmounted): back to idle. */
export function resetMailStreamStatus(): void {
  setState('connecting');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMailStreamState(): MailStreamState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => 'connecting',
  );
}

export function useMailStreamLive(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state === 'live',
    () => false,
  );
}

/** Fallback poll cadence: fast while the push stream is down, slow while it's up. */
export const MAIL_POLL_STREAM_DOWN_MS = 10_000;
export const MAIL_POLL_STREAM_UP_MS = 60_000;

export function useMailPollInterval(): number {
  return useMailStreamLive() ? MAIL_POLL_STREAM_UP_MS : MAIL_POLL_STREAM_DOWN_MS;
}
