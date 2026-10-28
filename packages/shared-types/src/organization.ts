import { z } from 'zod';

import { cuid } from './common/id.js';
import { mailHost } from './mail.js';

/**
 * Tenant-scoped feature toggles. The schema is intentionally open so admins
 * can flip flags forward without a code release, but each known flag is
 * declared explicitly so the typings stay useful at call sites.
 */
export const orgFeatureFlagsSchema = z
  .object({
    /// Enables the polar invoice integration for this tenant.
    invoicing: z.boolean().optional(),
    /// Lets the tenant configure their own SMTP/IMAP via OrganizationMailConfig.
    customMailTransport: z.boolean().optional(),
    /// Surfaces the cross-app "Share to chat" affordance for this tenant.
    chatShare: z.boolean().optional(),
  })
  .catchall(z.unknown());
export type OrgFeatureFlags = z.infer<typeof orgFeatureFlagsSchema>;

export const organizationSchema = z.object({
  id: cuid,
  name: z.string(),
  slug: z.string(),
  emailDomain: z.string().nullable(),
  isRoot: z.boolean(),
  isActive: z.boolean(),
  featureFlags: orgFeatureFlagsSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const organizationSummarySchema = organizationSchema.extend({
  memberCount: z.number().int().nonnegative(),
  workspaceCount: z.number().int().nonnegative(),
  /** Usage: total bytes of the org's live files. Never which files. Optional
   *  on the wire for rolling deploys, like `pending` below. */
  storageBytes: z.number().int().nonnegative().optional(),
  /** Whether the org has set up its own mail server. The settings themselves
   *  are visible to the org's admins only. */
  mailConfigured: z.boolean().optional(),
  /**
   * True when no member of this org has accepted an invitation yet
   * (nobody has a credential account or verified email). Surfaces as
   * a "Pending" badge in the admin org list so the operator can tell
   * at a glance which tenants are still waiting on first sign-in vs
   * which are in active use. Flips to `false` permanently as soon as
   * one member completes their invite-accept flow.
   *
   * Optional on the wire so an older API build (the one that hasn't
   * redeployed yet during a rolling release) doesn't crash the client
   * Zod parse with "expected boolean, received undefined". Consumers
   * read `org.pending === true` so `undefined` is treated as
   * "not pending", matching what the API would have returned anyway.
   */
  pending: z.boolean().optional(),
});
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

export const organizationListResponseSchema = z.object({
  items: z.array(organizationSummarySchema),
});
export type OrganizationListResponse = z.infer<typeof organizationListResponseSchema>;

/**
 * "Bootstrap the first owner" block - REQUIRED at org-creation time. The
 * API atomically provisions: a new User in the org, a Workspace named
 * after the org with that user as OWNER, and a 7-day invitation token
 * that the same accept-invite page consumes. We require this on every
 * create call so a tenant org never enters a permanent "no owner" limbo
 * - the admin would have had to send the invite via the retroactive
 * button anyway, so making it part of the create flow saves a step and
 * removes the failure mode where empty-shell orgs accumulate.
 */
export const createOrganizationFirstOwnerSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100),
});
export type CreateOrganizationFirstOwnerInput = z.infer<typeof createOrganizationFirstOwnerSchema>;

export const createOrganizationSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits, and dashes only'),
  emailDomain: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Must be a valid domain')
    .optional(),
  featureFlags: orgFeatureFlagsSchema.optional(),
  firstOwner: createOrganizationFirstOwnerSchema,
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/**
 * Response shape from POST /organizations. Always returns the new org row;
 * `invitationUrl` is only populated when `firstOwner` was supplied AND the
 * invitation email is awaiting acceptance (admins can copy-paste the link
 * if the recipient cannot find the email - same affordance as workspace
 * invites).
 */
export const createOrganizationResponseSchema = organizationSchema.extend({
  invitationUrl: z.string().url().nullable().optional(),
  /** The 6-digit code that goes with `invitationUrl`. */
  invitationCode: z.string().nullable().optional(),
});
export type CreateOrganizationResponse = z.infer<typeof createOrganizationResponseSchema>;

/**
 * Public self-serve organization signup (the "Are you an organization?"
 * flow linked from the sign-in page). Deliberately narrower than the
 * admin create call: no slug (server-generated from the name), no
 * emailDomain, no featureFlags - tenants get defaults and a global admin
 * can adjust later. The response is a bare ok flag: the invitation URL
 * must only ever travel via the owner's email, otherwise anyone could
 * sign up with someone else's address and hijack the invite link.
 */
/**
 * Optional SMTP/IMAP block a self-signing-up org may supply so it can use the
 * mail feature from day one. Distinct from `upsertOrganizationMailConfigSchema`
 * only in that the passwords are REQUIRED here - this is always a first-time
 * save, so there is no existing ciphertext to fall back to.
 */
export const publicSignupMailConfigSchema = z.object({
  smtpHost: mailHost,
  smtpPort: z.number().int().positive().max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().min(1).max(255),
  smtpPassword: z.string().min(1).max(255),
  imapHost: mailHost,
  imapPort: z.number().int().positive().max(65535),
  imapSecure: z.boolean(),
  imapUser: z.string().min(1).max(255),
  imapPassword: z.string().min(1).max(255),
  fromEmail: z.string().email(),
});
export type PublicSignupMailConfigInput = z.infer<typeof publicSignupMailConfigSchema>;

export const publicOrganizationSignupSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  /// Optional mail setup. When present the org's SMTP/IMAP transport is
  /// configured during provisioning; otherwise an admin can add it later.
  mailConfig: publicSignupMailConfigSchema.optional(),
});
export type PublicOrganizationSignupInput = z.infer<typeof publicOrganizationSignupSchema>;

export const publicOrganizationSignupResponseSchema = z.object({
  ok: z.literal(true),
});
export type PublicOrganizationSignupResponse = z.infer<
  typeof publicOrganizationSignupResponseSchema
>;

/**
 * Retroactively send (or resend) a first-owner invite to an existing
 * tenant. Email is required; name is optional here because the typical
 * use is a resend where the user record already exists with a name.
 */
export const inviteOrganizationOwnerSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100).optional(),
});
export type InviteOrganizationOwnerInput = z.infer<typeof inviteOrganizationOwnerSchema>;

export const inviteOrganizationOwnerResponseSchema = z.object({
  organization: organizationSchema,
  invitationUrl: z.string().url().nullable(),
  /** The 6-digit code that goes with `invitationUrl` (null for a sign-in link). */
  invitationCode: z.string().nullable().optional(),
  workspaceId: cuid,
});
export type InviteOrganizationOwnerResponse = z.infer<typeof inviteOrganizationOwnerResponseSchema>;

export const updateOrganizationSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    emailDomain: z
      .string()
      .max(253)
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i)
      .nullable()
      .optional(),
    isActive: z.boolean().optional(),
    featureFlags: orgFeatureFlagsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update',
  });
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

/**
 * Org mail config. Passwords are never returned in API responses; clients
 * see `••••••••` placeholders and may write fresh values that the server
 * re-encrypts.
 */
export const organizationMailConfigSchema = z.object({
  id: cuid,
  organizationId: cuid,
  smtpHost: z.string(),
  smtpPort: z.number().int().positive(),
  smtpSecure: z.boolean(),
  smtpUser: z.string(),
  imapHost: z.string(),
  imapPort: z.number().int().positive(),
  imapSecure: z.boolean(),
  imapUser: z.string(),
  fromEmail: z.string().email(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type OrganizationMailConfig = z.infer<typeof organizationMailConfigSchema>;

export const upsertOrganizationMailConfigSchema = z.object({
  smtpHost: mailHost,
  smtpPort: z.number().int().positive().max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().min(1).max(255),
  /// New password if provided. Omit to leave the existing ciphertext intact.
  smtpPassword: z.string().min(1).max(255).optional(),
  imapHost: mailHost,
  imapPort: z.number().int().positive().max(65535),
  imapSecure: z.boolean(),
  imapUser: z.string().min(1).max(255),
  imapPassword: z.string().min(1).max(255).optional(),
  fromEmail: z.string().email(),
});
export type UpsertOrganizationMailConfigInput = z.infer<typeof upsertOrganizationMailConfigSchema>;
