import { z } from 'zod';
import {
  type AdminCreateUserInput,
  type AdminImportWebmailUserInput,
  type AdminUpdateUserInput,
  type AdminUserListItem,
  adminUserListItemSchema,
  sessionsRevokedResponseSchema,
  type WebmailCandidate,
  webmailCandidateSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const adminUserListSchema = z.object({ items: z.array(adminUserListItemSchema) });
const webmailCandidatesSchema = z.object({ items: z.array(webmailCandidateSchema) });

/**
 * Diagnostic shape returned by `GET /admin/email/health`. Mirrors
 * EmailService.describeTransport - reports which mail transport is
 * active for the optionally-supplied org context and, for the env
 * transport, whether the SMTP verify call currently succeeds.
 */
const emailHealthSchema = z.object({
  transport: z.enum(['env', 'mail-account', 'org-mail-config', 'stub']),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  fromAddress: z.string().nullable(),
  verify: z
    .union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .nullable(),
});
export type EmailHealth = z.infer<typeof emailHealthSchema>;

/**
 * Admin user-management surface. Every method here hits an `/admin/users`
 * endpoint that returns 403 to non-admins; the frontend should already be
 * gating these calls behind a UI-level check but the server is authoritative.
 */
export class AdminResource {
  constructor(private readonly http: HttpClient) {}

  /** Users of the caller's own organization (always; no cross-org view). */
  listUsers(params?: { search?: string }): Promise<{ items: AdminUserListItem[] }> {
    const query: Record<string, string> = {};
    if (params?.search) query.search = params.search;
    return this.http.get(
      '/admin/users',
      adminUserListSchema,
      Object.keys(query).length > 0 ? query : undefined,
    );
  }
  createUser(input: AdminCreateUserInput): Promise<AdminUserListItem> {
    return this.http.post('/admin/users', adminUserListItemSchema, input);
  }
  updateUser(id: string, input: AdminUpdateUserInput): Promise<AdminUserListItem> {
    return this.http.patch(`/admin/users/${id}`, adminUserListItemSchema, input);
  }
  deleteUser(id: string) {
    return this.http.delete(`/admin/users/${id}`, okSchema);
  }
  /** Sign a user in the admin's own organization out of every device. */
  revokeUserSessions(id: string) {
    return this.http.post(`/admin/users/${id}/revoke-sessions`, sessionsRevokedResponseSchema, {});
  }
  /** Webmail mailboxes that exist on cPanel but aren't linked to a CRM user. */
  listWebmailCandidates(): Promise<{ items: WebmailCandidate[] }> {
    return this.http.get('/admin/users/webmail-candidates', webmailCandidatesSchema);
  }
  /** Attach an existing webmail mailbox to a CRM account by setting a known
   *  password on both sides. */
  importWebmailUser(input: AdminImportWebmailUserInput): Promise<AdminUserListItem> {
    return this.http.post('/admin/users/import', adminUserListItemSchema, input);
  }

  /**
   * Diagnose the mail transport. Returns which transport is active +
   * SMTP verify result (for the env path). Used by the admin UI when an
   * invitation email doesn't arrive - lets the operator see whether the
   * platform SMTP creds are even valid before suspecting Gmail spam,
   * DKIM issues, etc. Tenants get their own organization's transport;
   * SUPER_ADMIN gets the platform's env transport. No cross-org parameter.
   */
  emailHealth(): Promise<EmailHealth> {
    return this.http.get('/admin/email/health', emailHealthSchema);
  }
}
