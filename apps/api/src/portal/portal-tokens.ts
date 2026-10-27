import { randomBytes } from 'node:crypto';

/**
 * One-time portal links, stored as `VerificationToken` rows next to the
 * workspace invitations (`workspace-invite:{workspaceId}:{userId}`). The
 * identifier says what the link is for; the value is the secret in the URL.
 *
 * - `portal-invite`: a new client person sets their first password. Refused
 *   at accept time if the account already has one, so an invite link can
 *   never overwrite a password.
 * - `portal-reset`: a staff member sent a new-password link.
 */
export type PortalTokenKind = 'portal-invite' | 'portal-reset';

const PREFIX: Record<PortalTokenKind, string> = {
  'portal-invite': 'client-portal-invite',
  'portal-reset': 'client-portal-reset',
};

export const PORTAL_TOKEN_TTL_MS: Record<PortalTokenKind, number> = {
  'portal-invite': 7 * 24 * 60 * 60 * 1000,
  'portal-reset': 2 * 24 * 60 * 60 * 1000,
};

export function portalTokenIdentifier(
  kind: PortalTokenKind,
  clientId: string,
  userId: string,
): string {
  return `${PREFIX[kind]}:${clientId}:${userId}`;
}

/**
 * Where-filter for every link of one kind that one person holds, across all
 * clients (identifiers end in `:{userId}`). Setting or replacing the
 * account-wide password makes all of them moot.
 */
export function portalTokensForUser(kind: PortalTokenKind, userId: string) {
  return { identifier: { startsWith: `${PREFIX[kind]}:`, endsWith: `:${userId}` } };
}

/** Both identifiers for one person at one client, e.g. to revoke them all. */
export function portalTokenIdentifiers(clientId: string, userId: string): string[] {
  return (Object.keys(PREFIX) as PortalTokenKind[]).map((k) =>
    portalTokenIdentifier(k, clientId, userId),
  );
}

export function parsePortalTokenIdentifier(
  identifier: string,
): { kind: PortalTokenKind; clientId: string; userId: string } | null {
  for (const kind of Object.keys(PREFIX) as PortalTokenKind[]) {
    const prefix = `${PREFIX[kind]}:`;
    if (!identifier.startsWith(prefix)) continue;
    const rest = identifier.slice(prefix.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    const clientId = rest.slice(0, sep);
    const userId = rest.slice(sep + 1);
    if (!clientId || !userId || userId.includes(':')) return null;
    return { kind, clientId, userId };
  }
  return null;
}

/** 32 random bytes as hex: the shape `/invitations/:token` already accepts. */
export function newPortalTokenValue(): string {
  return randomBytes(32).toString('base64url');
}

export function portalTokenUrl(appUrl: string, value: string): string {
  return `${appUrl.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(value)}`;
}
