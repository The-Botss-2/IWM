'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useMailStreamState } from '@/lib/mail-stream-status';
import { useChatConnectionState } from '@/lib/realtime-status';

/** A drop shorter than this (a deploy restart, a network handover) stays silent. */
const SHOW_AFTER_MS = 3_000;

/**
 * Small "Reconnecting…" pill shown while a live connection is down: the chat
 * socket anywhere in the app, the mail push stream only on /mail routes (it
 * only runs there). Debounced so brief blips never flash it.
 */
export function ConnectionBanner() {
  const pathname = usePathname();
  const chat = useChatConnectionState();
  const mail = useMailStreamState();
  const mailDown = (pathname?.startsWith('/mail') ?? false) && mail === 'reconnecting';
  const message =
    chat === 'offline'
      ? 'Chat is offline. Refresh the page to reconnect.'
      : chat === 'reconnecting' || mailDown
        ? 'Reconnecting…'
        : null;

  const [visible, setVisible] = useState(false);
  const down = message !== null;
  useEffect(() => {
    if (!down) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [down]);

  if (!visible || !message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex justify-center px-4"
    >
      <span className="border-line bg-bg-surface text-ink-muted rounded-full border px-3 py-1 text-xs shadow-sm">
        {message}
      </span>
    </div>
  );
}
