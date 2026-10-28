import { rawPrisma } from '@botss/database';

import { hashPassword, verifyPassword } from './password.js';

export { hashPassword, verifyPassword } from './password.js';

export interface BetterAuthEnv {
  /** 32-byte hex secret. Must match the value used to sign session cookies. */
  secret: string;
  /** Base URL the API serves Better Auth from (e.g. http://localhost:4000). */
  baseURL: string;
  /** Origins allowed to send credentialed requests (the web app, etc). */
  trustedOrigins: string[];
  /**
   * Parent domain to scope the session cookie to (e.g. `.example.com`). When
   * set, the cookie is shared across subdomains - required so the web app at
   * `app.example.com` and the API at `api.example.com` see
   * the same session. Leave undefined in local dev to keep cookies host-only.
   */
  cookieDomain?: string;
  /**
   * Prefix for the session cookie names (Better Auth default: `better-auth`).
   * Set it on a second deployment that shares a parent domain with production
   * (e.g. staging), so the two never overwrite each other's session cookie.
   * Leave undefined in production: changing it signs every user out.
   */
  cookiePrefix?: string;
  /**
   * Called with the submitted email when a password sign-in fails. Observation
   * only: errors are swallowed and the response is never changed. The email is
   * for the receiver to resolve an account; it must not be stored or logged.
   */
  onSignInFailed?: (email: string) => void;
  /**
   * Invoked by Better Auth when `authClient.forgetPassword()` succeeds. The
   * URL already includes the signed reset token as a query param. Implement
   * to send the email; throw to surface a failure to the client.
   */
  sendResetPassword?: (args: {
    user: { email: string; name: string | null };
    url: string;
    token: string;
  }) => Promise<void>;
}

/**
 * Better Auth ships as ESM-only since v1.x. NestJS runs CommonJS and would
 * fail with `ERR_REQUIRE_ESM` on a static import. We use a `Function`-evaded
 * dynamic import so TypeScript's CJS emit doesn't rewrite it to `require()`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any, no-new-func
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>;

/**
 * Better Auth's instance type pulls in deep generic chains we don't want to
 * leak across packages. We expose `AppAuth` as a structural any that consumers
 * cast at the boundary (NestJS controllers, web client).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppAuth = any;

/**
 * Create the Better Auth instance bound to the project's Prisma client.
 *
 * Email + password is the only enabled provider for Phase 1. Other providers
 * (Google, GitHub, magic link) can be added here without touching the data
 * model - they all flow into the existing `Account` table.
 */
export async function createAuth(
  env: BetterAuthEnv,
  deps: {
    /**
     * Prisma client the adapter talks to. Defaults to `rawPrisma`; only
     * `apps/api/src/scripts/check-session-compat.ts` passes an in-memory
     * stand-in, to prove existing session cookies survive a Better Auth bump.
     */
    prisma?: unknown;
  } = {},
): Promise<AppAuth> {
  const [{ betterAuth }, { prismaAdapter }, { createAuthMiddleware }] = await Promise.all([
    dynamicImport('better-auth'),
    dynamicImport('better-auth/adapters/prisma'),
    dynamicImport('better-auth/api'),
  ]);

  // HTTPS deployments require Secure cookies, and a cross-origin browser fetch
  // (web app on `app.example.com` → API on `api.example.com`)
  // won't send a SameSite=Lax cookie back unless the request is a top-level
  // navigation. Both subdomains share `example.com` as the registrable site,
  // but the browser still treats fetch() POSTs as cross-site for cookie
  // purposes, so we promote to `SameSite=None; Secure` whenever we're on HTTPS.
  const isHttps = env.baseURL.startsWith('https://');
  const sharedAcrossSubdomains = !!env.cookieDomain;
  const sameSite: 'lax' | 'none' = isHttps || sharedAcrossSubdomains ? 'none' : 'lax';
  const secure = isHttps;

  // Do NOT declare `user.additionalFields` for `accountType`, `systemRole` or
  // `organizationId` without `input: false`: Better Auth lets a session write
  // any input-enabled field through `update-user`, which would let a client
  // portal account turn itself into staff. (apps/api also closes every Better
  // Auth route except sign-in, sign-out and get-session.)
  return betterAuth({
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: env.trustedOrigins,
    database: prismaAdapter(deps.prisma ?? rawPrisma, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      // Public sign-up is closed: new accounts only come from the admin
      // Users panel (or the workspace invitation accept flow, which creates
      // the credential server-side). This blocks /api/auth/sign-up/email
      // returning 403 to anyone who hits it directly.
      disableSignUp: true,
      // Custom hash/verify keeps admin-create, sign-in, and the workspace-
      // invitation accept flow all using one password format. See
      // packages/auth/src/password.ts.
      password: {
        hash: async (password: string) => hashPassword(password),
        verify: async ({ hash, password }: { hash: string; password: string }) =>
          verifyPassword(hash, password),
      },
      // Self-serve password reset is intentionally not wired. The CRM is
      // admin-managed; password rotation goes through the admin Users panel
      // (AdminUsersService.update) which keeps CRM, MailAccount, and cPanel
      // credentials in lock-step. Better Auth still exposes the
      // /sign-in/email endpoint normally - only the reset email path is
      // omitted.
    },
    // Persistent sessions so desktop / mobile webviews stay signed in across
    // app restarts. `rememberMe: true` (the sign-in default) issues a cookie
    // that lives for the full `expiresIn`; `rememberMe: false` downgrades to
    // a browser-session cookie that clears on close. `updateAge` slides the
    // expiry forward at most once a day so active users never get logged out.
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh the expiry at most once per day
    },
    hooks: {
      // After every sign-in attempt: a thrown APIError in `returned` means the
      // credentials were refused. Only tells the caller; never alters the reply.
      after: createAuthMiddleware(
        async (ctx: {
          path: string;
          body?: { email?: unknown };
          context: { returned?: unknown };
        }) => {
          if (!env.onSignInFailed || ctx.path !== '/sign-in/email') return;
          try {
            const returned = ctx.context.returned;
            const failed =
              returned instanceof Error || (returned instanceof Response && !returned.ok);
            const email = ctx.body?.email;
            if (failed && typeof email === 'string') env.onSignInFailed(email);
          } catch {
            // Observation only.
          }
        },
      ),
    },
    verification: {
      modelName: 'VerificationToken',
    },
    advanced: {
      useSecureCookies: false,
      ...(env.cookiePrefix ? { cookiePrefix: env.cookiePrefix } : {}),
      // Enable + set the parent domain on the session cookie so it survives
      // cross-subdomain navigation. Disabled in local dev where `cookieDomain`
      // is undefined.
      crossSubDomainCookies: env.cookieDomain
        ? { enabled: true, domain: env.cookieDomain }
        : { enabled: false },
      defaultCookieAttributes: {
        sameSite,
        secure,
        httpOnly: true,
        ...(env.cookieDomain ? { domain: env.cookieDomain } : {}),
      },
      // Let Prisma's `@default(cuid())` generate row IDs instead of Better
      // Auth's internal random format, so all of our IDs follow one convention.
      database: { generateId: false },
    },
  });
}
