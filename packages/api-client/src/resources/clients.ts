import { z } from 'zod';
import {
  type Client,
  type ClientActivityList,
  clientActivityListSchema,
  type ClientBillingSummary,
  clientBillingSummarySchema,
  type ClientCustomFieldValueList,
  clientCustomFieldValueListSchema,
  type ClientDocumentList,
  clientDocumentListSchema,
  type ClientHubPageQuery,
  type ClientSignatureList,
  clientSignatureListSchema,
  type CustomFieldValue,
  customFieldValueSchema,
  type SetClientCustomFieldInput,
  clientContactLinkResponseSchema,
  type ClientContactLinkResponse,
  clientContactListSchema,
  type ClientContactList,
  clientContactSchema,
  type ClientContact,
  type InviteClientContactInput,
  type UpdateClientContactInput,
  clientDetailSchema,
  clientSchema,
  clientWithOwnerSchema,
  type CreateClientInput,
  type ListClientsQuery,
  listResponseSchema,
  type UpdateClientInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const clientListResponseSchema = listResponseSchema(clientWithOwnerSchema);

export class ClientsResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListClientsQuery>) {
    return this.http.get('/clients', clientListResponseSchema, query);
  }
  get(id: string) {
    return this.http.get(`/clients/${id}`, clientDetailSchema);
  }
  create(input: CreateClientInput): Promise<Client> {
    return this.http.post('/clients', clientSchema, input);
  }
  update(id: string, input: UpdateClientInput): Promise<Client> {
    return this.http.patch(`/clients/${id}`, clientSchema, input);
  }
  remove(id: string) {
    return this.http.delete(`/clients/${id}`, okSchema);
  }

  // Client portal: who at this client may sign in -------------------------

  portalContacts(clientId: string): Promise<ClientContactList> {
    return this.http.get(`/clients/${clientId}/portal-contacts`, clientContactListSchema);
  }
  invitePortalContact(
    clientId: string,
    input: InviteClientContactInput,
  ): Promise<ClientContactLinkResponse> {
    return this.http.post(`/clients/${clientId}/portal-contacts`, clientContactLinkResponseSchema, input);
  }
  resendPortalInvite(clientId: string, contactId: string): Promise<ClientContactLinkResponse> {
    return this.http.post(
      `/clients/${clientId}/portal-contacts/${contactId}/resend`,
      clientContactLinkResponseSchema,
      {},
    );
  }
  sendPortalPasswordReset(clientId: string, contactId: string): Promise<ClientContactLinkResponse> {
    return this.http.post(
      `/clients/${clientId}/portal-contacts/${contactId}/password-reset`,
      clientContactLinkResponseSchema,
      {},
    );
  }
  updatePortalContact(
    clientId: string,
    contactId: string,
    input: UpdateClientContactInput,
  ): Promise<ClientContact> {
    return this.http.patch(`/clients/${clientId}/portal-contacts/${contactId}`, clientContactSchema, input);
  }
  revokePortalContact(clientId: string, contactId: string) {
    return this.http.delete(`/clients/${clientId}/portal-contacts/${contactId}`, okSchema);
  }

  // Client hub: everything about one client on the client page ------------

  /** Documents filed under the client, in its projects, or shared with it. */
  documents(clientId: string): Promise<ClientDocumentList> {
    return this.http.get(`/clients/${clientId}/documents`, clientDocumentListSchema);
  }
  /** Signature requests tied to the client, newest first (drafts excluded). */
  signatures(clientId: string, query?: Partial<ClientHubPageQuery>): Promise<ClientSignatureList> {
    return this.http.get(`/clients/${clientId}/signatures`, clientSignatureListSchema, query);
  }
  /** Per-currency billing totals. Finance roles only (403 otherwise). */
  billingSummary(clientId: string): Promise<ClientBillingSummary> {
    return this.http.get(`/clients/${clientId}/billing-summary`, clientBillingSummarySchema);
  }
  /** Merged activity feed, newest first; pass `nextCursor` for the next page. */
  activity(clientId: string, query?: Partial<ClientHubPageQuery>): Promise<ClientActivityList> {
    return this.http.get(`/clients/${clientId}/activity`, clientActivityListSchema, query);
  }
  /** Values of the workspace's CLIENT custom fields on this client. */
  customFields(clientId: string): Promise<ClientCustomFieldValueList> {
    return this.http.get(`/clients/${clientId}/custom-fields`, clientCustomFieldValueListSchema);
  }
  setCustomField(
    clientId: string,
    definitionId: string,
    input: SetClientCustomFieldInput,
  ): Promise<CustomFieldValue> {
    return this.http.put(
      `/clients/${clientId}/custom-fields/${definitionId}`,
      customFieldValueSchema,
      input,
    );
  }
  clearCustomField(clientId: string, definitionId: string) {
    return this.http.delete(`/clients/${clientId}/custom-fields/${definitionId}`, okSchema);
  }
}
