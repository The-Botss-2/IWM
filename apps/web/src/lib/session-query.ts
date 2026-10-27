'use client';

import { queryOptions } from '@tanstack/react-query';
import type { SessionContext } from '@botss/shared-types';

import { getApi } from './api';
import { handleSupportSessionError } from './support-session';

export const sessionQueryKey = ['session'] as const;

/** Only these statuses mean "you are not signed in". */
export function isAuthFailure(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * `/auth/me`. A support session that the server says is over (revoked,
 * expired, invalid) answers 403, which must not read as "signed out": leave
 * the support session (reloads onto the Organizations page) and load the
 * operator's own session meanwhile.
 */
async function loadSession(): Promise<SessionContext> {
  try {
    return (await getApi().users.session()) as SessionContext;
  } catch (err) {
    if (!handleSupportSessionError(err)) throw err;
    return (await getApi().users.session()) as SessionContext;
  }
}

/**
 * The one definition of the session query. Every consumer of the
 * `['session']` key must use it: TanStack merges observers on the same key,
 * and two observers with different retry rules made failures behave
 * differently depending on which one happened to trigger the fetch.
 *
 * Failure policy, which is what stops the random logouts:
 * - 401/403 fail immediately; the caller redirects to sign-in.
 * - Everything else (offline, DNS not ready after wake, a 502 during a deploy,
 *   a 503 while the database recovers, a 429) retries with backoff instead of
 *   being read as "signed out".
 * - No refetch on reconnect or focus. Those fire exactly when the network is
 *   least likely to be up (laptop wake, Wi-Fi to LTE, tray resume).
 */
export const sessionQueryOptions = queryOptions({
  queryKey: sessionQueryKey,
  queryFn: loadSession,
  staleTime: 60_000,
  retry: (failureCount, err) => !isAuthFailure(err) && failureCount < 4,
  retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  // SessionGate owns session failures (redirect / "reconnecting" pill).
  meta: { silentError: true },
});

/**
 * Where to land right after signing in: client-portal accounts go to
 * `/portal`, everyone else to `/home`. If the lookup fails the app shell
 * still sorts it out (SessionGate sends a client account to `/portal`).
 */
export async function landingPathAfterSignIn(): Promise<string> {
  try {
    const session = await getApi().users.session();
    return session.user.accountType === 'CLIENT' ? '/portal' : '/home';
  } catch {
    return '/home';
  }
}
