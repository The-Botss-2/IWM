import { z } from 'zod';

/**
 * Login-free links (e-signature, workspace invitations) use two factors:
 *
 * 1. The link token: 32 random bytes as base64url (exactly 43 characters,
 *    no padding). It is the unguessable part and lives only in the email.
 * 2. A short 6-digit code (shown as XXX-XXX) printed in the same email and
 *    typed on the page. It is the part a forwarded or leaked URL lacks, and
 *    the API locks the link after a few wrong guesses.
 */
export const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid link');

/** Number of wrong codes after which a link is locked. */
export const MAX_ACCESS_CODE_ATTEMPTS = 5;

/** "842-195", "842195" or "842 195"; normalised to the 6 digits. */
export const accessCode = z
  .string()
  .trim()
  .transform((v) => v.replace(/[-\s]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email'));
export type AccessCode = z.infer<typeof accessCode>;

/** Header the signing page sends its code in (GET endpoints have no body). */
export const ACCESS_CODE_HEADER = 'x-access-code';
