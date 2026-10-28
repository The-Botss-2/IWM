import { z } from 'zod';
import {
  createOrganizationResponseSchema,
  type CreateOrganizationInput,
  type CreateOrganizationResponse,
  inviteOrganizationOwnerResponseSchema,
  type InviteOrganizationOwnerInput,
  type InviteOrganizationOwnerResponse,
  organizationListResponseSchema,
  type OrganizationListResponse,
  organizationSchema,
  type Organization,
  publicOrganizationSignupResponseSchema,
  type PublicOrganizationSignupInput,
  type PublicOrganizationSignupResponse,
  type UpdateOrganizationInput,
  type UpsertOrganizationMailConfigInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.literal(true) });

const mailConfigPublicSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number().int().nonnegative(),
  smtpSecure: z.boolean(),
  smtpUser: z.string(),
  imapHost: z.string(),
  imapPort: z.number().int().nonnegative(),
  imapSecure: z.boolean(),
  imapUser: z.string(),
  fromEmail: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export class OrganizationsResource {
  constructor(private readonly http: HttpClient) {}

  list(): Promise<OrganizationListResponse> {
    return this.http.get('/organizations', organizationListResponseSchema);
  }

  create(input: CreateOrganizationInput): Promise<CreateOrganizationResponse> {
    return this.http.post('/organizations', createOrganizationResponseSchema, input);
  }

  /**
   * Public self-serve signup (unauthenticated). Provisions the org and
   * emails the owner an invitation to set their password - the response
   * deliberately carries no invitation URL.
   */
  signup(input: PublicOrganizationSignupInput): Promise<PublicOrganizationSignupResponse> {
    return this.http.post('/org-signup', publicOrganizationSignupResponseSchema, input);
  }

  update(orgId: string, input: UpdateOrganizationInput): Promise<Organization> {
    return this.http.patch(`/organizations/${orgId}`, organizationSchema, input);
  }

  softDelete(orgId: string) {
    return this.http.delete(`/organizations/${orgId}`, okSchema);
  }

  /**
   * Retroactively send a first-owner invite to an existing tenant. Used for
   * orgs created before the create-with-owner flow shipped or where the
   * admin skipped the optional first-owner fields at creation time.
   */
  inviteOwner(
    orgId: string,
    input: InviteOrganizationOwnerInput,
  ): Promise<InviteOrganizationOwnerResponse> {
    return this.http.post(
      `/organizations/${orgId}/invite-owner`,
      inviteOrganizationOwnerResponseSchema,
      input,
    );
  }

  /** Restore an archived (soft-deleted) tenant. */
  restore(orgId: string): Promise<Organization> {
    return this.http.post(`/organizations/${orgId}/restore`, organizationSchema, {});
  }

  /** Irreversible hard cascade delete. Distinct method so consumer code is
   *  explicit about which destructive path it's invoking. */
  hardDelete(orgId: string) {
    return this.http.delete(
      `/organizations/${orgId}/hard`,
      z.object({ ok: z.literal(true), mode: z.literal('hard') }),
    );
  }

  /**
   * Tenant self-service: read/write the caller's OWN organization mail config.
   * Server derives the org from the session and requires an org admin, so no
   * orgId is passed. Used by the in-app settings surface.
   */
  getMyMailConfig() {
    return this.http.get(
      '/org/mail-config',
      z.object({ config: mailConfigPublicSchema.nullable() }),
    );
  }

  upsertMyMailConfig(input: UpsertOrganizationMailConfigInput) {
    return this.http.put('/org/mail-config', mailConfigPublicSchema, input);
  }
}
