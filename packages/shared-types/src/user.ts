import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema } from './common/pagination.js';

/* eslint-disable @typescript-eslint/no-redeclare */

/**
 * Cross-workspace role mirrored from `prisma.SystemRole`. Append-only;
 * the Postgres enum on production already carries the same set, and
 * reordering would break stored values.
 *
 * - `SUPER_ADMIN`: platform operator, restricted to the Botss root org
 *   by a Postgres trigger. Gates organization management and the
 *   platform log only; no access to data inside other organizations.
 * - `ADMIN`: scoped to one org (tenant or root). Tenant admin.
 * - `HR`: scoped to one org's Attendance + Leave.
 * - `FINANCE`: scoped to one org's Contracts, Payments, Expenses and
 *   Invoices. Mirrors HR - an org-level role, NOT a workspace role, so a
 *   workspace OWNER does not get money access by virtue of owning a
 *   workspace. See `hasFinanceAccess` in `@botss/auth`.
 * - `EMPLOYEE` / `PROJECT_MANAGER`: regular member roles.
 */
export const SystemRole = z.enum([
  'ADMIN',
  'PROJECT_MANAGER',
  'EMPLOYEE',
  'HR',
  'SUPER_ADMIN',
  'FINANCE',
]);
export type SystemRole = z.infer<typeof SystemRole>;

/**
 * Mirrors `prisma.AccountType`. `STAFF` works in the CRM; `CLIENT` is a
 * person at one of our clients who can only use the client portal. The API
 * refuses a CLIENT account on every internal route.
 */
export const AccountType = z.enum(['STAFF', 'CLIENT']);
export type AccountType = z.infer<typeof AccountType>;

export const userSchema = z.object({
  id: cuid,
  email: z.string().email(),
  emailVerified: z.boolean(),
  name: z.string().min(1).max(100),
  image: z.string().url().nullable(),
  phone: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  // Defaulted so existing endpoints that haven't been updated to project
  // systemRole still parse successfully - they get EMPLOYEE which is the
  // most-restrictive sensible default.
  systemRole: SystemRole.default('EMPLOYEE'),
  /// Defaulted for the same reason as `systemRole`: endpoints that do not
  /// select it still parse, as STAFF.
  accountType: AccountType.default('STAFF'),
  /// Tenant org pointer. Surfaced so the web UI can distinguish a root-org
  /// admin (global admin) from a tenant-org admin without an extra fetch.
  /// Nullable for legacy rows that have not yet been auto-routed.
  organizationId: cuid.nullable().default(null),
  /// Custom company role, when one is assigned (else the systemRole preset).
  customRoleId: cuid.nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type User = z.infer<typeof userSchema>;

/** Compact user shape for embedding in other resources (no PII beyond name+image). */
export const userSummarySchema = userSchema.pick({
  id: true,
  name: true,
  email: true,
  image: true,
});
export type UserSummary = z.infer<typeof userSummarySchema>;

/**
 * Avatar URL a user may set. `z.string().url()` alone accepts `javascript:`,
 * `data:`, `file:` and plain-http URLs; the avatar is rendered for every
 * colleague, so only https is allowed (uploads come back from object
 * storage as https). Response schemas stay lenient so legacy rows parse.
 */
export const avatarUrl = z
  .string()
  .url()
  .max(2048)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'The image must be an https URL.');

export const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  image: avatarUrl.nullable().optional(),
  phone: z.string().nullable().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * Query shape for the admin users list endpoint. `organizationId` is
 * honoured ONLY when the caller is a SUPER_ADMIN; for everyone else
 * the server pins the result to the caller's own org (the param is
 * ignored, not rejected, so a stale UI doesn't 400).
 */
export const listAdminUsersQuerySchema = z.object({
  search: z.string().optional(),
  organizationId: cuid.optional(),
});
export type ListAdminUsersQuery = z.infer<typeof listAdminUsersQuerySchema>;

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

/** Admin-only: create a new user with a password. For emails on the cPanel-managed domain (CPANEL_DOMAIN)
 *  the server also auto-provisions a MailAccount using these credentials. */
export const adminCreateUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(256),
  systemRole: SystemRole.default('EMPLOYEE'),
  /** Optional initial workspace. When omitted the user is created without a
   *  workspace membership; the admin assigns one later. */
  workspaceId: cuid.optional(),
  /** Per-workspace role applied to the membership when workspaceId is set. */
  workspaceRole: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']).optional(),
});
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;

/** Admin-only: update an existing user. Password is optional - when present
 *  it resets the Better Auth credential AND (for CPANEL_DOMAIN users) the
 *  encrypted MailAccount password so webmail and CRM stay in sync. */
export const adminUpdateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  password: z.string().min(8).max(256).optional(),
  systemRole: SystemRole.optional(),
  phone: z.string().max(50).nullable().optional(),
  /** When true the user is exempt from timesheet-submission warnings. */
  timesheetExempt: z.boolean().optional(),
});
export type AdminUpdateUserInput = z.infer<typeof adminUpdateUserSchema>;

// Note: redefine systemRole without `.default(...)` so that the inferred
// input/output types are identical. The `.default` on `userSchema` is for
// tolerant response parsing across older endpoints; here we always select
// the column so it's reliably present.
export const adminUserListItemSchema = z.object({
  id: cuid,
  email: z.string().email(),
  name: z.string().min(1).max(100),
  image: z.string().url().nullable(),
  emailVerified: z.boolean(),
  systemRole: SystemRole,
  /// When true, exempt from timesheet-submission warnings. The admin API
  /// always selects this column, so it's reliably present (no default - a
  /// default would make the inferred input/output types diverge).
  timesheetExempt: z.boolean(),
  /// Custom company role id, or null for the systemRole preset.
  customRoleId: cuid.nullable().optional(),
  createdAt: z.coerce.date(),
});
export type AdminUserListItem = z.infer<typeof adminUserListItemSchema>;

/** Existing cPanel mailbox not yet linked to a CRM User. The admin "imports"
 *  one of these to attach it to a CRM account with a known password. */
export const webmailCandidateSchema = z.object({
  email: z.string().email(),
  quotaMb: z.number().int().nonnegative(),
  diskUsedBytes: z.number().int().nonnegative(),
});
export type WebmailCandidate = z.infer<typeof webmailCandidateSchema>;

/** Admin-only: import an existing webmail user into the CRM. The password
 *  the admin supplies is written to both the CRM credential AND cPanel
 *  (via `Email::passwd_pop`), so the user signs in with the same secret
 *  in webmail and the CRM after import. */
export const adminImportWebmailUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(256),
  systemRole: SystemRole.default('EMPLOYEE'),
  workspaceId: cuid.optional(),
  workspaceRole: z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']).optional(),
});
export type AdminImportWebmailUserInput = z.infer<
  typeof adminImportWebmailUserSchema
>;
