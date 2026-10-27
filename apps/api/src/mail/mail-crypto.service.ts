import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for MailAccount.passwordCiphertext. Layout of the persisted
 * payload:
 *
 *     [12 bytes IV][16 bytes authTag][N bytes ciphertext]
 *
 * IV is generated fresh per encrypt() call. Reusing IVs under GCM with the
 * same key destroys confidentiality, so do NOT reuse.
 *
 * The key comes from `MAIL_ENCRYPTION_KEY` - a 64-hex-character string
 * (32 bytes after decoding). Boot fails loudly if it is missing or wrong
 * length. Rotating it means re-encrypting every stored mail password, so do
 * not change it on an install that already has mail accounts.
 */
@Injectable()
export class MailCryptoService implements OnModuleInit {
  private readonly logger = new Logger(MailCryptoService.name);
  private key: Buffer | null = null;

  onModuleInit(): void {
    const raw = process.env.MAIL_ENCRYPTION_KEY?.trim();
    if (!raw) {
      throw new Error(
        'MAIL_ENCRYPTION_KEY is not set. Generate via `openssl rand -hex 32` and add to .env.',
      );
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error(
        'MAIL_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes after decoding).',
      );
    }
    this.key = Buffer.from(raw, 'hex');
    // Never log the key. Log only that it loaded successfully.
    this.logger.log('MailCryptoService ready (AES-256-GCM).');
  }

  encrypt(plaintext: string): Buffer {
    if (!this.key) throw new Error('MailCryptoService not initialised.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]);
  }

  decrypt(payload: Buffer): string {
    if (!this.key) throw new Error('MailCryptoService not initialised.');
    if (payload.length < 12 + 16 + 1) {
      throw new Error('Ciphertext payload is too short to contain IV + tag + body.');
    }
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
