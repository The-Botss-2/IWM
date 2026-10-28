import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

/**
 * AES-256-GCM helpers used by the OrganizationMailConfig store. We pin
 * the ciphertext to the string format `iv.hex:cipher.hex:tag.hex` so the
 * stored token is self-describing and doesn't need a binary column.
 *
 * The master key lives in `ENCRYPTION_KEY` as a base64-encoded 32-byte
 * value. Loading it once at module init means a missing/invalid key
 * fails the app at boot instead of failing the first email send.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM-recommended 96-bit IV
const KEY_BYTES = 32; // AES-256

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const rawMailKey = process.env.MAIL_ENCRYPTION_KEY?.trim();
  const rawKey = process.env.ENCRYPTION_KEY?.trim();
  const raw = rawMailKey || rawKey;
  if (!raw) {
    throw new Error(
      'MAIL_ENCRYPTION_KEY (or ENCRYPTION_KEY) is not set. Provide a 32-byte key in the environment.',
    );
  }
  let buf: Buffer;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      buf = Buffer.from(raw, 'hex');
    } else {
      buf = Buffer.from(raw, 'base64');
    }
  } catch {
    throw new Error('Encryption key must be valid hex or base64.');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`Encryption key must decode to exactly ${KEY_BYTES} bytes; got ${buf.length}.`);
  }
  cachedKey = buf;
  return buf;
}

export function encrypt(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt(plaintext) requires a string.');
  }
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv) as CipherGCM;
  const cipherBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${cipherBuf.toString('hex')}:${tag.toString('hex')}`;
}

export function decrypt(token: string): string {
  if (typeof token !== 'string') {
    throw new TypeError('decrypt(token) requires a string.');
  }
  const parts = token.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext: expected iv:cipher:tag hex triple.');
  }
  const [ivHex, cipherHex, tagHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const cipherBuf = Buffer.from(cipherHex!, 'hex');
  const tag = Buffer.from(tagHex!, 'hex');
  if (iv.length !== IV_BYTES) {
    throw new Error('Malformed ciphertext: bad IV length.');
  }
  const key = loadKey();
  const decipher = createDecipheriv(ALGO, key, iv) as DecipherGCM;
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
  return plain.toString('utf8');
}
