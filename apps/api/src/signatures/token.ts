import { createHash, randomBytes } from 'node:crypto';

import { hashLinkToken, newAccessCode, newLinkToken } from '../common/access-code';

/**
 * Signing links. The token in the URL is 32 random bytes as base64url (the
 * credential); a 6-digit code emailed next to it is the second factor (see
 * common/access-code.ts). Only hashes are stored (`SignatureSigner.tokenHash`
 * and `codeHash`), so a database leak does not leak live signing access.
 *
 * Never log a raw token, a raw code or a signing URL.
 */
export function newSigningToken(): { raw: string; hash: string } {
  return newLinkToken();
}

/** A fresh link plus its code, as stored on the signer and put in the email. */
export function newSigningCredentials(): {
  token: { raw: string; hash: string };
  code: { raw: string; hash: string };
} {
  return { token: newLinkToken(), code: newAccessCode() };
}

export function hashSigningToken(raw: string): string {
  return hashLinkToken(raw);
}

/** A hash no token can produce, for DRAFT signers that were never emailed and
 *  for signers whose link was retired. `tokenHash` is unique and non-null. */
export function unusableTokenHash(): string {
  return `draft-${randomBytes(24).toString('hex')}`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function signingUrl(rawToken: string): string {
  const base = (process.env.PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/sign/${rawToken}`;
}
