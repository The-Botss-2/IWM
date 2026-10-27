/**
 * Better Auth serves every one of its endpoints under `/api/auth/*`, mounted
 * in `main.ts` OUTSIDE Nest, so AuthGuard never sees those requests. The apps
 * only call three of them (sign-in, sign-out and get-session - checked by
 * grep across apps/web, apps/desktop and apps/mobile). Everything else is
 * closed for every account, and in particular for client-portal accounts:
 *
 * - `update-user` writes `name` / `image` with no validation, and staff
 *   screens render both (a client could plant a tracking image or a name that
 *   breaks a staff list).
 * - `change-password` would let a staff member drift their CRM password away
 *   from their webmail password; staff rotation goes through the admin Users
 *   panel, and client people use `POST /api/v1/portal/me/password`.
 * - `change-email`, `delete-user`, session listing/revoking, sign-up and the
 *   reset flow are unused.
 *
 * Deny by default: a path is open only if it is listed here exactly.
 */
export const BETTER_AUTH_BASE_PATH = '/api/auth';

const ALLOWED_ROUTES: ReadonlyArray<readonly [method: string, path: string]> = [
  ['POST', '/sign-in/email'],
  ['POST', '/sign-out'],
  ['GET', '/get-session'],
];

export function isAllowedBetterAuthRoute(method: string, fullPath: string): boolean {
  if (!fullPath.startsWith(`${BETTER_AUTH_BASE_PATH}/`)) return false;
  const path = fullPath.slice(BETTER_AUTH_BASE_PATH.length).replace(/\/+$/, '');
  const verb = method.toUpperCase();
  return ALLOWED_ROUTES.some(
    ([allowedVerb, allowedPath]) =>
      allowedPath === path && (allowedVerb === verb || (allowedVerb === 'GET' && verb === 'HEAD')),
  );
}
