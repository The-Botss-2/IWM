import { z } from 'zod';

import { cuid } from './common/id.js';
import { userSummarySchema } from './user.js';

/**
 * Support access: an organization admin lets the platform operators
 * (SUPER_ADMIN) read the organization for a limited time. The grant is
 * read only, every request made under it lands in the organization's own
 * audit log, and it ends by itself at `expiresAt` (or earlier on revoke).
 */

/** Longest grant an organization admin can create. */
export const SUPPORT_GRANT_MAX_DAYS = 30;
export const SUPPORT_GRANT_MAX_MS = SUPPORT_GRANT_MAX_DAYS * 24 * 60 * 60 * 1000;

/** Quick presets offered next to a custom end time. */
export const SUPPORT_GRANT_PRESETS = ['1h', '24h', '72h'] as const;
export const supportGrantPresetSchema = z.enum(SUPPORT_GRANT_PRESETS);
export type SupportGrantPreset = z.infer<typeof supportGrantPresetSchema>;

const PRESET_MS: Record<SupportGrantPreset, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '72h': 72 * 60 * 60 * 1000,
};

/**
 * Create a grant: a preset duration OR a custom end time, never both.
 * Whether the end time is in the future and within the 30 day cap depends
 * on "now", so `resolveSupportGrantExpiry` checks that (API and form share it).
 */
export const createSupportGrantSchema = z
  .object({
    duration: supportGrantPresetSchema.optional(),
    expiresAt: z.coerce.date().optional(),
    /** Optional note for the support team (what to look at). */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.duration === undefined) !== (v.expiresAt === undefined), {
    message: 'Pick a preset duration or a custom end time.',
    path: ['duration'],
  });
export type CreateSupportGrantInput = z.infer<typeof createSupportGrantSchema>;

export type SupportGrantExpiryResult =
  | { ok: true; expiresAt: Date }
  | { ok: false; code: 'support-grant-in-past' | 'support-grant-too-long'; reason: string };

/**
 * When a new grant ends, or why it can't be created. Pure: `now` is passed
 * in. A custom end time must be in the future and at most 30 days away.
 */
export function resolveSupportGrantExpiry(
  input: Pick<CreateSupportGrantInput, 'duration' | 'expiresAt'>,
  now: Date,
): SupportGrantExpiryResult {
  const expiresAt = input.duration
    ? new Date(now.getTime() + PRESET_MS[input.duration])
    : input.expiresAt
      ? new Date(input.expiresAt.getTime())
      : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      code: 'support-grant-in-past',
      reason: 'The end time has to be in the future.',
    };
  }
  if (expiresAt.getTime() - now.getTime() > SUPPORT_GRANT_MAX_MS) {
    return {
      ok: false,
      code: 'support-grant-too-long',
      reason: `Support access can last at most ${SUPPORT_GRANT_MAX_DAYS} days. Pick an earlier end time.`,
    };
  }
  return { ok: true, expiresAt };
}

export const supportGrantStatusSchema = z.enum(['ACTIVE', 'EXPIRED', 'REVOKED']);
export type SupportGrantStatus = z.infer<typeof supportGrantStatusSchema>;

/** Status of a grant at `now`. Pure. */
export function supportGrantStatus(
  grant: { expiresAt: Date; revokedAt: Date | null },
  now: Date,
): SupportGrantStatus {
  if (grant.revokedAt) return 'REVOKED';
  return grant.expiresAt.getTime() > now.getTime() ? 'ACTIVE' : 'EXPIRED';
}

/** A grant as the organization's admins see it. */
export const supportGrantSchema = z.object({
  id: cuid,
  expiresAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
  readOnly: z.boolean(),
  reason: z.string().nullable(),
  createdAt: z.coerce.date(),
  status: supportGrantStatusSchema,
  grantedBy: userSummarySchema.nullable(),
  revokedBy: userSummarySchema.nullable(),
});
export type SupportGrant = z.infer<typeof supportGrantSchema>;

export const supportGrantListResponseSchema = z.object({
  items: z.array(supportGrantSchema),
});
export type SupportGrantListResponse = z.infer<typeof supportGrantListResponseSchema>;

/**
 * SUPER_ADMIN view: which organizations currently allow support access.
 * Only what is needed to open a session; nothing from inside the org.
 */
export const activeSupportGrantSchema = z.object({
  grantId: cuid,
  organizationId: cuid,
  organizationName: z.string(),
  expiresAt: z.coerce.date(),
  readOnly: z.boolean(),
  reason: z.string().nullable(),
});
export type ActiveSupportGrant = z.infer<typeof activeSupportGrantSchema>;

export const activeSupportGrantListResponseSchema = z.object({
  items: z.array(activeSupportGrantSchema),
});
export type ActiveSupportGrantListResponse = z.infer<typeof activeSupportGrantListResponseSchema>;

export const startSupportSessionSchema = z.object({ grantId: cuid });
export type StartSupportSessionInput = z.infer<typeof startSupportSessionSchema>;

/** The support session a request runs in (also on `/auth/me`). */
export const supportSessionInfoSchema = z.object({
  grantId: cuid,
  organizationId: cuid,
  organizationName: z.string(),
  expiresAt: z.coerce.date(),
  readOnly: z.boolean(),
});
export type SupportSessionInfo = z.infer<typeof supportSessionInfoSchema>;

/**
 * A started support session. `token` goes in the `x-support-token` header
 * of every request; it is signed, tied to the grant, the super admin and
 * their sign-in session, and never outlives the grant.
 */
export const supportSessionSchema = supportSessionInfoSchema.extend({
  token: z.string().min(1).max(2048),
});
export type SupportSession = z.infer<typeof supportSessionSchema>;

/** Header that carries the support session token. */
export const SUPPORT_TOKEN_HEADER = 'x-support-token';

/** Problem `code`s that mean the support session is over (the web exits it). */
export const SUPPORT_SESSION_END_CODES = [
  'support-session-ended',
  'support-session-invalid',
  'support-not-allowed',
] as const;
