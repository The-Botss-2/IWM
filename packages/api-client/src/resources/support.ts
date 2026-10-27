import {
  activeSupportGrantListResponseSchema,
  supportGrantListResponseSchema,
  supportGrantSchema,
  supportSessionSchema,
  type ActiveSupportGrantListResponse,
  type CreateSupportGrantInput,
  type SupportGrant,
  type SupportGrantListResponse,
  type SupportSession,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/** Support access: org admin grants, and platform operator support sessions. */
export class SupportResource {
  constructor(private readonly http: HttpClient) {}

  /** The caller's organization's grants, newest first (company `org.settings`). */
  listGrants(): Promise<SupportGrantListResponse> {
    return this.http.get('/support/grants', supportGrantListResponseSchema);
  }

  createGrant(input: CreateSupportGrantInput): Promise<SupportGrant> {
    return this.http.post('/support/grants', supportGrantSchema, input);
  }

  revokeGrant(grantId: string): Promise<SupportGrant> {
    return this.http.post(
      `/support/grants/${encodeURIComponent(grantId)}/revoke`,
      supportGrantSchema,
      {},
    );
  }

  /** SUPER_ADMIN only: organizations whose support grant is active now. */
  listActiveGrants(): Promise<ActiveSupportGrantListResponse> {
    return this.http.get('/support/active-grants', activeSupportGrantListResponseSchema);
  }

  /** SUPER_ADMIN only: open a read only support session on an active grant. */
  startSession(grantId: string): Promise<SupportSession> {
    return this.http.post('/support/sessions', supportSessionSchema, { grantId });
  }
}
