'use client';

import {
  SUPPORT_SESSION_END_CODES,
  supportSessionSchema,
  type SupportSession,
} from '@botss/shared-types';

/**
 * The platform operator's read only support session in THIS tab. The token
 * lives in sessionStorage, so it ends when the tab closes and never leaks
 * into other tabs; `getApi()` sends it as `x-support-token` on every request.
 * The server is authoritative: it re-checks the grant on every request and
 * this store only drops the token once the server says the session is over.
 *
 * The active workspace of the session lives here too, never in the
 * `currentWorkspaceId` cookie: that cookie is shared by every tab, so writing
 * the granted organization's workspace into it would point the operator's
 * other tabs at a workspace they aren't a member of.
 */

const STORAGE_KEY = 'botss.supportSession';
/** The granted organization's workspace this tab works in. */
const WORKSPACE_KEY = 'botss.supportSession.workspace';
/** Written by an older build; removed on exit. */
const LEGACY_PREVIOUS_WORKSPACE_KEY = 'botss.supportSession.previousWorkspace';

let current: SupportSession | null | undefined;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function load(): SupportSession | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = supportSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function emit(): void {
  for (const l of listeners) l();
}

/** The running support session of this tab, or null. */
export function getSupportSession(): SupportSession | null {
  if (current === undefined) current = load();
  return current;
}

export function subscribeSupportSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Header value for `getApi()`, or null outside a support session. */
export function supportTokenHeader(): string | null {
  return getSupportSession()?.token ?? null;
}

let memoryWorkspace: string | null = null;

/** The support session's workspace in this tab (sent as `x-workspace-id`). */
export function readSupportWorkspace(): string | null {
  try {
    return storage()?.getItem(WORKSPACE_KEY) ?? memoryWorkspace;
  } catch {
    return memoryWorkspace;
  }
}

export function writeSupportWorkspace(workspaceId: string | null): void {
  memoryWorkspace = workspaceId;
  try {
    if (workspaceId) storage()?.setItem(WORKSPACE_KEY, workspaceId);
    else storage()?.removeItem(WORKSPACE_KEY);
  } catch {
    // Storage blocked: kept in memory for this page load.
  }
}

/**
 * Enter a support session. The workspace cookie is left alone: the granted
 * organization picks its own workspace (AuthGuard falls back to its first
 * one) and SessionGate keeps the active one in this tab's storage.
 */
export function beginSupportSession(session: SupportSession): void {
  const s = storage();
  try {
    s?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked: the session still works for this page load.
  }
  writeSupportWorkspace(null);
  current = session;
  emit();
}

/** Leave the support session; the operator's own workspace cookie never changed. */
export function endSupportSession(): void {
  const s = storage();
  try {
    s?.removeItem(STORAGE_KEY);
    s?.removeItem(LEGACY_PREVIOUS_WORKSPACE_KEY);
  } catch {
    // Nothing stored to clean up.
  }
  writeSupportWorkspace(null);
  current = null;
  emit();
}

/** Whether an API error means the support session is over (ended, revoked, invalid). */
export function isSupportSessionEndError(err: unknown): boolean {
  const code = (err as { problem?: { code?: unknown } } | null)?.problem?.code;
  return (
    typeof code === 'string' && (SUPPORT_SESSION_END_CODES as readonly string[]).includes(code)
  );
}

/** Where the operator lands after a support session; `?support=ended` explains why. */
export const SUPPORT_EXIT_PATH = '/admin/organizations';

/**
 * Enter a support session and reload the app inside the granted
 * organization. A full navigation drops every cached query of the operator's
 * own organization, so nothing from it is shown under the support banner.
 */
export function openSupportSession(session: SupportSession): void {
  beginSupportSession(session);
  if (typeof window !== 'undefined') window.location.assign('/home');
}

/**
 * Leave the support session and reload back on the Organizations page.
 * `ended` = the server ended it (revoked, expired, suspended).
 */
export function leaveSupportSession(opts: { ended?: boolean } = {}): void {
  endSupportSession();
  if (typeof window !== 'undefined') {
    window.location.assign(opts.ended ? `${SUPPORT_EXIT_PATH}?support=ended` : SUPPORT_EXIT_PATH);
  }
}

/**
 * Called for every failed query or mutation: when the server says the
 * running support session is over, leave it. Returns true when handled.
 */
export function handleSupportSessionError(err: unknown): boolean {
  if (!getSupportSession() || !isSupportSessionEndError(err)) return false;
  leaveSupportSession({ ended: true });
  return true;
}
