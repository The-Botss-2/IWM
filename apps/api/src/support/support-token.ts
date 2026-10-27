import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Support session tokens. A token is `<payload>.<signature>`, both base64url:
 * the payload names the grant, the super admin and the sign-in session it was
 * issued to, plus an expiry that is never later than the grant's end. The
 * signature is an HMAC over the payload with a key derived from the server
 * secret, so a token can't be forged or edited (another grant, another
 * user, a later expiry).
 *
 * The token alone never grants anything: AuthGuard also requires the same
 * signed-in super admin and session, and re-reads the grant on every request,
 * so a revoked or expired grant is refused on the very next request.
 *
 * Pure: the secret and "now" are passed in.
 */

export interface SupportTokenPayload {
  /** Grant id. */
  g: string;
  /** Super admin user id. */
  u: string;
  /** Better Auth session id the token was issued to. */
  s: string;
  /** Expiry, epoch milliseconds. */
  e: number;
}

const KEY_CONTEXT = 'botss-support-session-token:v1';

function deriveKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_CONTEXT).digest();
}

function sign(payloadPart: string, secret: string): string {
  return createHmac('sha256', deriveKey(secret)).update(payloadPart).digest('base64url');
}

export function signSupportToken(payload: SupportTokenPayload, secret: string): string {
  if (!secret) throw new Error('signSupportToken: missing secret');
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${sign(payloadPart, secret)}`;
}

export type SupportTokenCheck =
  | { ok: true; payload: SupportTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

/** Verify signature and expiry. Never throws. */
export function verifySupportToken(token: string, secret: string, now: Date): SupportTokenCheck {
  if (!secret || typeof token !== 'string' || token.length > 2048) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadPart, signaturePart] = parts as [string, string];

  const expected = Buffer.from(sign(payloadPart, secret), 'base64url');
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPayload(payload)) return { ok: false, reason: 'malformed' };
  if (payload.e <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

function isPayload(value: unknown): value is SupportTokenPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['g'] === 'string' &&
    v['g'].length > 0 &&
    typeof v['u'] === 'string' &&
    v['u'].length > 0 &&
    typeof v['s'] === 'string' &&
    v['s'].length > 0 &&
    typeof v['e'] === 'number' &&
    Number.isFinite(v['e'])
  );
}

/** The server secret support tokens are signed with (Better Auth's secret). */
export function supportTokenSecret(): string {
  return process.env.BETTER_AUTH_SECRET ?? '';
}
