'use client';

import { useEffect } from 'react';
import type { PushPlatform } from '@botss/shared-types';

import { getApi } from '@/lib/api';

/**
 * Bridge for native mobile push. The Expo WebView shell (apps/mobile) injects
 * its push token into the page - it can't register the token itself because the
 * Better Auth session lives in the WebView's cookies, so the web app (which has
 * the session) does the registration. No-op on the browser/desktop, where no
 * token is ever injected.
 *
 * The token is registered against the current user so the backend can deliver
 * FCM pushes that reach the device even when the app is fully closed.
 */

// Remembered so sign-out can unregister this device from the server.
let knownToken: string | null = null;
let lastRegistered: string | null = null;

function isPlatform(value: unknown): value is PushPlatform {
  return value === 'android' || value === 'ios' || value === 'expo';
}

function register(token: string, platform: PushPlatform): void {
  if (!token || token === lastRegistered) return;
  lastRegistered = token;
  knownToken = token;
  void getApi()
    .notifications.registerPushDevice({ token, platform })
    .catch(() => {
      // Best-effort; the shell re-injects on every load so we'll retry.
      lastRegistered = null;
    });
}

/** Call on sign-out so the signed-out device stops receiving this user's pushes. */
export async function unregisterNativePush(): Promise<void> {
  const token = knownToken;
  if (!token) return;
  knownToken = null;
  lastRegistered = null;
  // Best-effort during sign-out - a failure here must never block signing out.
  await getApi().notifications.unregisterPushDevice(token).catch(() => {});
}

export function useNativePush(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const onToken = (e: Event): void => {
      const detail = (e as CustomEvent).detail as
        | { token?: unknown; platform?: unknown }
        | undefined;
      const token = detail?.token;
      const platform = isPlatform(detail?.platform) ? detail.platform : 'android';
      if (typeof token === 'string') register(token, platform);
    };
    window.addEventListener('botss:push-token', onToken);

    // The shell may have injected the token before this mounted; pick it up.
    const existing = (window as unknown as { __BOTSS_PUSH_TOKEN__?: unknown })
      .__BOTSS_PUSH_TOKEN__;
    if (typeof existing === 'string') register(existing, 'android');

    return () => window.removeEventListener('botss:push-token', onToken);
  }, [enabled]);
}
