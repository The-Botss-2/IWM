import { z } from 'zod';

import { accessCode, linkToken } from './common/access-code.js';
import { cuid } from './common/id.js';
import { paginationQuerySchema } from './common/pagination.js';
import { WorkspaceRole } from './enums.js';
import { userSummarySchema } from './user.js';

export const workspaceSchema = z.object({
  id: cuid,
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9](-?[a-z0-9])*$/, 'Slug must be lowercase alphanumerics and hyphens'),
  description: z.string().nullable(),
  logoUrl: z.string().url().nullable(),
  ownerId: cuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceSchema = workspaceSchema
  .pick({
    name: true,
    slug: true,
  })
  .extend({
    description: z.string().optional(),
  });
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = createWorkspaceSchema.partial().extend({
  logoUrl: z.string().url().nullable().optional(),
});
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

// Workspace membership
export const workspaceMembershipSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  userId: cuid,
  role: WorkspaceRole,
  invitedById: cuid.nullable(),
  /// Custom workspace role, when one is assigned (else the `role` preset).
  customRoleId: cuid.nullable().optional(),
  joinedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type WorkspaceMembership = z.infer<typeof workspaceMembershipSchema>;

export const workspaceMembershipWithUserSchema = workspaceMembershipSchema.extend({
  user: userSummarySchema,
  /**
   * True when the linked User has no credential Account row yet AND their email
   * is unverified - i.e. the invitation hasn't been accepted. The Members table
   * renders these with a "Pending" badge and exposes Resend / Revoke actions.
   */
  pending: z.boolean(),
  /** Display label for the member's company role (custom role name or the
   *  systemRole preset). Optional for older API builds. */
  companyRole: z.string().nullable().optional(),
});
export type WorkspaceMembershipWithUser = z.infer<typeof workspaceMembershipWithUserSchema>;

export const inviteMemberSchema = z.object({
  email: z.string().email(),
  // CLIENT is excluded: that workspace role is NOT client-portal access (it
  // reads workspace-wide). Client people are invited from a client's Portal
  // tab instead. Existing CLIENT memberships keep working.
  // Omitted = derived from the invitee's company role: org ADMIN / SUPER_ADMIN
  // join as workspace ADMIN, everyone else as MEMBER.
  role: WorkspaceRole.exclude(['OWNER', 'CLIENT']).optional(),
  /** Optional display name. Falls back to the local part of the email. */
  name: z.string().min(1).max(100).optional(),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

export const updateMembershipSchema = z.object({
  // No new CLIENT assignments (see inviteMemberSchema); a legacy CLIENT
  // member can still be moved to another role.
  role: WorkspaceRole.exclude(['CLIENT']),
  /** Custom workspace role (null clears it back to the `role` preset). */
  customRoleId: cuid.nullable().optional(),
});
export type UpdateMembershipInput = z.infer<typeof updateMembershipSchema>;

/**
 * Response shape from POST /workspaces/current/members and from the Resend
 * action. We always end up with a User + Membership row; `invitationUrl` is
 * present when the invitee still needs to set a password (either a brand-new
 * user or an existing pending one whose token was just regenerated).
 */
export const inviteMemberResponseSchema = z.object({
  membership: workspaceMembershipWithUserSchema,
  user: userSummarySchema,
  invitationUrl: z.string().url().nullable(),
  /** The 6-digit code (XXX-XXX) that goes with `invitationUrl`; both are
   *  needed to accept. Shown to the inviter for sharing by hand. */
  invitationCode: z.string().nullable().optional(),
  wasNewUser: z.boolean(),
});
export type InviteMemberResponse = z.infer<typeof inviteMemberResponseSchema>;

/**
 * What a one-time link is for. `workspace` joins a staff member to a
 * workspace; `portal-invite` gives a client person their first password;
 * `portal-reset` replaces a client person's forgotten password.
 */
export const InvitationKind = z.enum(['workspace', 'portal-invite', 'portal-reset']);
export type InvitationKind = z.infer<typeof InvitationKind>;

/**
 * One-time link token in `/invitations/accept?token=...`: 32 random bytes as
 * base64url, or the 64-hex shape of portal links minted before 2026-10.
 */
export const invitationToken = z.union([
  linkToken,
  z.string().regex(/^[0-9a-f]{64}$/, 'Invalid link'),
]);

/**
 * Public payload of GET /api/v1/invitations/:token. Deliberately says
 * nothing about who was invited where: a workspace invitation reveals that
 * only after the 6-digit code from the email is verified.
 */
export const invitationPreviewSchema = z.object({
  kind: InvitationKind,
  /** True for workspace invitations: POST /verify with the emailed code. */
  requiresCode: z.boolean(),
});
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/** Body of POST /invitations/:token/verify. */
export const verifyInvitationSchema = z.object({
  code: accessCode.optional(),
});
export type VerifyInvitationInput = z.input<typeof verifyInvitationSchema>;

/**
 * Returned by POST /api/v1/invitations/:token/verify once the code checks
 * out (portal links need no code). Used by the accept page (no auth) to
 * greet the invitee with workspace + inviter context.
 */
export const invitationInfoSchema = z.object({
  email: z.string().email(),
  /** The workspace name, or for the portal kinds the company inviting them. */
  workspaceName: z.string(),
  inviterName: z.string().nullable(),
  /**
   * True when the invitee already has a credential Account (e.g. an existing
   * teammate who was just added to a new workspace). The accept page shows
   * "Sign in" instead of "Set password" in that case.
   */
  hasPassword: z.boolean(),
  /** Absent reads as `workspace`. Optional rather than defaulted so the SDK's
   *  input and output types match. */
  kind: InvitationKind.optional(),
  /** Portal kinds only: the client company whose portal the person joins. */
  clientName: z.string().nullable().optional(),
});
export type InvitationInfo = z.infer<typeof invitationInfoSchema>;

export const acceptInvitationSchema = z.object({
  password: z.string().min(8, 'Use at least 8 characters.').max(128),
  /** Required for workspace invitations (the code from the email). */
  code: accessCode.optional(),
});
export type AcceptInvitationInput = z.input<typeof acceptInvitationSchema>;

export const acceptInvitationResponseSchema = z.object({
  ok: z.literal(true),
  workspaceId: cuid,
  userId: cuid,
  /** Where the web app should land after signing in (absent reads as app). */
  destination: z.enum(['app', 'portal']).optional(),
});
export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>;

export const listWorkspacesQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
});
export type ListWorkspacesQuery = z.infer<typeof listWorkspacesQuerySchema>;
