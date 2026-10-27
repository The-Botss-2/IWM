'use client';

import { useSyncExternalStore } from 'react';

import { reconnectChatSocket } from '@/lib/chat-socket';

/**
 * Single source of truth for "is the app worth spending battery on right now?".
 * Battery optimisation hangs off this: components pause animations / timers when
 * the window is hidden or the user has gone idle, and back off polling.
 *
 *   active - visible and recently interacted with
 *   idle   - visible but no input for IDLE_AFTER (slow things down, don't stop)
 *   hidden - tab/window not visible, or the desktop OS is suspending
 *
 * Deliberately NOT wired to the chat socket: on desktop the window lives in the
 * tray so the socket must stay connected to keep delivering calls + chat
 * notifications; on mobile the WebView is frozen by the OS when backgrounded, so
 * the socket drops on its own and push wakes it. Killing it on `hidden` would
 * silence tray notifications. The one link: on desktop resume the socket is
 * reconnected straight away if the sleep dropped it, since tray notifications
 * ride on it.
 */
export type AppActivity = 'active' | 'hidden' | 'idle';

const IDLE_AFTER = 60_000;

let state: AppActivity = 'active';
const listeners = new Set<() => void>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const l of listeners) l();
}

function set(next: AppActivity): void {
  if (next === state) return;
  state = next;
  emit();
}

function goHidden(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  set('hidden');
}

function bumpActive(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return;
  }
  set('active');
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => set('idle'), IDLE_AFTER);
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') goHidden();
    else bumpActive();
  });

  // Passive so we never block scrolling/typing just to track activity.
  for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(evt, bumpActive, { passive: true });
  }

  // Desktop (Electron) exposes OS power transitions the DOM can't see. Treat a
  // system suspend like "hidden" so timers/animations are already stopped before
  // the machine sleeps, and re-evaluate on resume.
  const desktop = (
    window as unknown as {
      botssDesktop?: {
        onPowerStateChange?: (cb: (s: string) => void) => void;
      };
    }
  ).botssDesktop;
  desktop?.onPowerStateChange?.((s: string) => {
    if (s === 'suspend') goHidden();
    else if (s === 'resume') {
      bumpActive();
      reconnectChatSocket();
    }
  });

  bumpActive();
}

/** Imperative read for non-React call sites (e.g. inside a query's refetchInterval). */
export function getAppActivity(): AppActivity {
  return state;
}

/** Imperative subscription for non-React call sites. Returns an unsubscribe fn. */
export function subscribeAppActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding. SSR-safe: renders as 'active' on the server. */
export function useAppActivity(): AppActivity {
  return useSyncExternalStore(
    subscribeAppActivity,
    getAppActivity,
    () => 'active',
  );
}
