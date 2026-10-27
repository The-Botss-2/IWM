'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getApi } from '@/lib/api';
import { resetMailStreamStatus, setMailStreamLive } from '@/lib/mail-stream-status';

/** Backoff before re-opening a stream the server closed (capped at 1 min). */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];

/**
 * Subscribe to server-sent events from the API and invalidate the mail
 * TanStack queries whenever the IDLE watcher pushes a `folder-updated`
 * event. This is what makes new mail appear "instantly" - without it the UI
 * relies on the 30s polling fallback.
 *
 * EventSource carries the auth cookie automatically when `withCredentials`
 * is set, so we don't need an Authorization header. The connection is
 * single-direction (server → client) and reconnects on its own after network
 * drops; a stream the server closed (non-200 reconnect) is re-opened here
 * with a backoff. Everything is cleaned up on unmount.
 */
export function useMailEvents(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    const url = getApi().mail.eventsUrl();
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const onFolderUpdated = () => {
      qc.invalidateQueries({ queryKey: ['mail', 'messages'] });
      qc.invalidateQueries({ queryKey: ['mail', 'folders'] });
    };

    // Track liveness so the mail queries can poll slowly while push works
    // and fall back to the fast poll while it doesn't. No toast on error -
    // EventSource's built-in retry handles transient disconnects, and an
    // error toast on every WiFi hiccup would be noise. A drop that lasts
    // shows the shell's "Reconnecting…" banner instead (ConnectionBanner).
    const onOpen = () => {
      attempt = 0;
      setMailStreamLive(true);
    };
    const onError = () => {
      setMailStreamLive(false);
      // A non-200 answer to a reconnect (502/503 during a deploy) closes the
      // stream for good - EventSource only retries network-level drops. Open
      // a fresh one after a capped backoff; the fast fallback poll covers the
      // gap and the status stays 'reconnecting' meanwhile.
      if (source?.readyState === EventSource.CLOSED) scheduleReconnect();
    };

    const detach = () => {
      if (!source) return;
      source.removeEventListener('folder-updated', onFolderUpdated);
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.close();
      source = null;
    };

    const connect = () => {
      detach(); // never two streams at once
      try {
        source = new EventSource(url, { withCredentials: true });
      } catch {
        // EventSource constructor never throws in modern browsers but guard
        // anyway - in unsupported envs we silently degrade to the poll.
        return;
      }
      source.addEventListener('folder-updated', onFolderUpdated);
      source.addEventListener('open', onOpen);
      source.addEventListener('error', onError);
    };

    function scheduleReconnect() {
      if (disposed || retryTimer) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) connect();
      }, delay);
    }

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      detach();
      resetMailStreamStatus();
    };
  }, [enabled, qc]);
}
