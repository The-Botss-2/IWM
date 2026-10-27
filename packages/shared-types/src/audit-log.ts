import { z } from 'zod';

import { cuid } from './common/id.js';
import { paginationQuerySchema } from './common/pagination.js';
import { userSummarySchema } from './user.js';

/**
 * Security alerts raised by the API's `SecurityAlertsService`. Metadata is
 * counts, the window and a user id only - never content, passwords or emails.
 */
export const SECURITY_ALERT_ACTIONS = [
  'security.failed_signins',
  'security.mass_delete',
  'security.new_admin',
  'security.large_export',
  'security.large_import',
] as const;
export type SecurityAlertAction = (typeof SECURITY_ALERT_ACTIONS)[number];

/**
 * Canonical action tokens emitted by `AuditLogService.emit`. Open-ended:
 * the column is a free-form string, so new actions don't need a schema
 * edit before they can be logged - but well-known actions live here so
 * the UI can render friendly labels + filter dropdowns.
 */
export const auditActionSchema = z.enum([
  'org.create',
  'org.update',
  'org.archive',
  'org.restore',
  'org.hard_delete',
  'org.mail_config_update',
  'workspace.create',
  'workspace.update',
  'workspace.delete',
  'workspace.member.invite',
  'workspace.member.resend',
  'workspace.member.revoke',
  'workspace.member.role_change',
  'workspace.member.remove',
  'user.create',
  'user.update',
  'user.delete',
  'user.role_change',
  'user.sessions_revoked',
  'project.member.add',
  'project.member.role_change',
  'project.member.remove',
  'document.access.add',
  'document.access.remove',
  'security.failed_signins',
  'security.mass_delete',
  'security.new_admin',
  'security.large_export',
  'security.large_import',
  'support.grant_created',
  'support.grant_revoked',
  'support.access',
  'support.session_started',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

// Prisma `@default(cuid())` ids: 25 chars starting with "c". Kept lenient so a
// cuid2-style id still matches. The root organization is the one seeded row
// with a fixed, non-cuid id (`ROOT_ORG_ID` in apps/api).
const AUDIT_ID_PATTERN = /^c[a-z0-9]{19,31}$/;
const ROOT_ORG_ID_LITERAL = 'org_root_thebotss';

/**
 * Whether a string stored in an audit row is a record id rather than a word
 * (roles like "ADMIN", emails, slugs, permission keys). Shared so the API
 * looks up exactly the ids the UI refuses to print.
 */
export function looksLikeAuditId(value: string): boolean {
  return value === ROOT_ORG_ID_LITERAL || AUDIT_ID_PATTERN.test(value);
}

/**
 * Human-readable form of `target` (`"<type>:<id>"`). `name` is null when the
 * record no longer exists or belongs to another organization, so the UI can
 * say "deleted" instead of printing the raw id.
 */
export const auditTargetLabelSchema = z.object({
  type: z.string(),
  name: z.string().nullable(),
});
export type AuditTargetLabel = z.infer<typeof auditTargetLabelSchema>;

export const auditLogEntrySchema = z.object({
  id: cuid,
  organizationId: cuid,
  actorUserId: cuid.nullable(),
  action: z.string(),
  target: z.string().nullable(),
  targetLabel: auditTargetLabelSchema.nullable(),
  metadata: z.record(z.unknown()),
  /** Display names for the ids that appear in `target` and `metadata`,
   *  keyed by id. Only records in the entry's own organization resolve. */
  labels: z.record(z.string()),
  createdAt: z.coerce.date(),
  actorUser: userSummarySchema.nullable(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

/**
 * The organization's own audit log. Always the caller's organization - there
 * is no cross-org parameter, for SUPER_ADMIN either; platform operators read
 * the platform log instead.
 */
export const listAuditLogQuerySchema = paginationQuerySchema.extend({
  /** Filter by action. Free-form so unknown actions still match. */
  action: z.string().min(1).max(80).optional(),
  /** Filter by actor user id. */
  actorUserId: cuid.optional(),
  /** Free-text search across action, target, and actor name/email. */
  search: z.string().min(1).max(120).optional(),
  /** Platform log only: show just the security alerts. Query-string boolean. */
  alertsOnly: z.enum(['true', 'false']).optional(),
});
export type ListAuditLogQuery = z.infer<typeof listAuditLogQuerySchema>;

export const auditLogListResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  }),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

/**
 * Actions shown in the SUPER_ADMIN platform log: organization-level events
 * only, never anything that happens inside an organization.
 */
export const PLATFORM_AUDIT_ACTIONS = [
  'org.create',
  'org.update',
  'org.archive',
  'org.restore',
  'org.hard_delete',
  'org.invite_owner',
  ...SECURITY_ALERT_ACTIONS,
  // Support grants: the platform log shows only the organization, the end
  // time and the read only flag (see AuditLogService.listPlatform).
  'support.grant_created',
  'support.grant_revoked',
] as const;

export const platformLogEntrySchema = auditLogEntrySchema.extend({
  /** The organization the event is about; null once it was hard-deleted
   *  and its name was not recorded. */
  organizationName: z.string().nullable(),
});
export type PlatformLogEntry = z.infer<typeof platformLogEntrySchema>;

export const platformLogListResponseSchema = auditLogListResponseSchema.extend({
  items: z.array(platformLogEntrySchema),
});
export type PlatformLogListResponse = z.infer<typeof platformLogListResponseSchema>;
