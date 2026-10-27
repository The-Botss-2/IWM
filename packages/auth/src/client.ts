/**
 * Better Auth's React client is ESM-only. The web app (Next.js) runs ESM by
 * default so a static import works fine there - but if a consumer is in a CJS
 * runtime they'll need to dynamic-import this module too.
 */

export interface BetterAuthClientEnv {
  /** Base URL of the API (e.g. http://localhost:4000). */
  baseURL: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppAuthClient = any;

/**
 * Build the Better Auth React client used by the Next.js app for sign-in,
 * sign-up, sign-out, and session reads.
 *
 * NOTE: This is async because Better Auth ships ESM-only. The web app calls
 * `await createBotssAuthClient(...)` once at module init and exposes the
 * result via a singleton.
 */
export async function createBotssAuthClient(env: BetterAuthClientEnv): Promise<AppAuthClient> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, no-new-func
  const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
  const { createAuthClient } = await dynamicImport('better-auth/react');
  return createAuthClient({ baseURL: env.baseURL });
}
