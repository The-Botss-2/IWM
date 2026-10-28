/**
 * Tiny browser-side reader/writer for the `currentWorkspaceId` cookie. The
 * API's AuthGuard reads `x-workspace-id` from request headers; we mirror that
 * choice into a cookie because cookies survive page navigation and tabs,
 * whereas localStorage is per-origin per-tab and wouldn't compose with SSR.
 */

export const CURRENT_WORKSPACE_COOKIE = 'currentWorkspaceId';

const MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export function readWorkspaceCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CURRENT_WORKSPACE_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1] ?? '') || null : null;
}

export function writeWorkspaceCookie(workspaceId: string): void {
  if (typeof document === 'undefined') return;
  // SameSite=Lax + Path=/ so the cookie is sent with same-site XHRs (fetch to
  // the API origin during local dev shares the registrable domain). In prod we
  // rely on the same eTLD+1 between web and API; cross-origin setups would
  // need Secure + SameSite=None which we'd toggle here.
  const attrs = `Path=/; Max-Age=${MAX_AGE_SECONDS}; SameSite=Lax`;
  document.cookie = `${CURRENT_WORKSPACE_COOKIE}=${encodeURIComponent(workspaceId)}; ${attrs}`;
}

export function clearWorkspaceCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${CURRENT_WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
