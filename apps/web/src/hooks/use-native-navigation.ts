'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Bridge for notification taps in the Expo WebView shell (apps/mobile), the
 * Electron desktop shell (apps/desktop) and in-page banner clicks
 * (`lib/desktop-runtime`). Each dispatches a cancelable `botss:navigate`
 * event with the target URL; handling it here turns the tap into a client-side route change instead of a
 * full page load, which is both faster and avoids a fresh network round trip
 * right as the device wakes up. Cancelling the event tells the shell we took
 * it - left uncancelled (signed out, other origin), the shell falls back to a
 * full navigation. No-op in a plain browser, where nothing dispatches it.
 */
export function useNativeNavigation(enabled: boolean): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onNavigate = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { url?: unknown } | undefined;
      if (typeof detail?.url !== 'string') return;
      let target: URL;
      try {
        target = new URL(detail.url, window.location.origin);
      } catch {
        return;
      }
      if (target.origin !== window.location.origin) return;
      e.preventDefault();
      router.push(`${target.pathname}${target.search}${target.hash}`);
    };
    window.addEventListener('botss:navigate', onNavigate);
    return () => window.removeEventListener('botss:navigate', onNavigate);
  }, [enabled, router]);
}
