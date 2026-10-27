import {
  type AcceptInvitationInput,
  acceptInvitationResponseSchema,
  invitationInfoSchema,
  invitationPreviewSchema,
  type VerifyInvitationInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/**
 * `/invitations/accept?token=...`. `preview` says what kind of link it is
 * and whether it needs the emailed code; `verify` checks the code and returns
 * who/where; `accept` sets the first password (with the code again).
 */
export class InvitationsResource {
  constructor(private readonly http: HttpClient) {}

  preview(token: string) {
    return this.http.get(`/invitations/${encodeURIComponent(token)}`, invitationPreviewSchema);
  }

  verify(token: string, input: VerifyInvitationInput) {
    return this.http.post(
      `/invitations/${encodeURIComponent(token)}/verify`,
      invitationInfoSchema,
      input,
    );
  }

  accept(token: string, input: AcceptInvitationInput) {
    return this.http.post(
      `/invitations/${encodeURIComponent(token)}/accept`,
      acceptInvitationResponseSchema,
      input,
    );
  }
}
