'use client';

import { createAuthClient } from 'better-auth/react';

import { env } from './env';

/**
 * Better Auth client used by the web app for sign-in / sign-up / sign-out / session.
 *
 * NOTE: do NOT destructure methods off this client (e.g. `const { signUp } = authClient`).
 * Better Auth v1.x exposes nested endpoints (`signUp.email`, `signIn.email`) through a
 * Proxy that loses its handler when detached from the client object - destructured
 * references throw at call time. Always call as `authClient.signUp.email({...})`.
 */
export const authClient = createAuthClient({
  baseURL: env.apiUrl,
});

/** `useSession` is a plain hook, not a Proxy - safe to re-export directly. */
export const useSession = authClient.useSession;
