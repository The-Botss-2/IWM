/**
 * Password hashing used by Better Auth's credential provider AND by the
 * workspace-invitation accept flow. Keeping a single format here means both
 * paths produce hashes that Better Auth's sign-in path will verify.
 *
 * Format: `scrypt$<saltHex>$<hashHex>` where the hash is N=16384, r=8, p=1,
 * keylen=64 - Node's `crypto.scryptSync` defaults except for `N` which we set
 * explicitly so future Node default changes don't shift the encoding.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const PREFIX = 'scrypt$';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return `${PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(hash: string, password: string): boolean {
  if (!hash.startsWith(PREFIX)) return false;
  const rest = hash.slice(PREFIX.length);
  const [saltHex, hashHex] = rest.split('$');
  if (!saltHex || !hashHex) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
