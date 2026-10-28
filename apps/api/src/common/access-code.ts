import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { MAX_ACCESS_CODE_ATTEMPTS } from '@botss/shared-types';

/**
 * Two-factor login-free links (signing, workspace invitations).
 *
 * - The LINK TOKEN is 32 random bytes as base64url (43 chars): the actual
 *   credential, never guessable. Stored only as a sha256.
 * - The CODE is 6 digits shown as XXX-XXX, printed in the same email and
 *   typed on the page. It protects a link that leaked on its own (forwarded
 *   URL, proxy log, browser history). Stored only as a sha256, with an
 *   attempt counter that locks the link after MAX_ACCESS_CODE_ATTEMPTS.
 *
 * A 6-digit code is never a lookup key: it is only ever compared against the
 * one row the link token already selected, so codes need not be unique.
 * Never log a raw token, a raw code or a URL containing a token.
 */

export { MAX_ACCESS_CODE_ATTEMPTS };

export function newLinkToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashLinkToken(raw) };
}

export function hashLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Digits only: "842-195", "842 195" and "842195" are the same code. */
export function normalizeAccessCode(raw: string): string {
  return raw.trim().replace(/[-\s]/g, '');
}

export function newAccessCode(): { raw: string; hash: string } {
  // randomInt's upper bound is exclusive: 000000..999999, zero-padded.
  const digits = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const raw = `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return { raw, hash: hashAccessCode(raw) };
}

export function hashAccessCode(raw: string): string {
  return createHash('sha256')
    .update(`access-code:${normalizeAccessCode(raw)}`)
    .digest('hex');
}

/** Constant-time comparison of a typed code against the stored hash. */
export function accessCodeMatches(
  raw: string | null | undefined,
  storedHash: string | null,
): boolean {
  if (!raw || !storedHash) return false;
  const normalized = normalizeAccessCode(raw);
  if (!/^\d{6}$/.test(normalized)) return false;
  const a = Buffer.from(hashAccessCode(normalized), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True once a link has used up its wrong guesses. */
export function attemptsExhausted(attempts: number): boolean {
  return attempts >= MAX_ACCESS_CODE_ATTEMPTS;
}
