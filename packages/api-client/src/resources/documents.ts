import { z } from 'zod';
import {
  type AddDocumentAccessInput,
  type CreateDocumentInput,
  type Document,
  type DocumentAccess,
  documentAccessListSchema,
  documentAccessSchema,
  documentSchema,
  documentWithCreatorSchema,
  type ListDocumentsQuery,
  listResponseSchema,
  type PublicDocument,
  publicDocumentSchema,
  type SharePublicLinkInput,
  type UpdateDocumentAccessInput,
  type UpdateDocumentInput,
  type AddDocumentClientShareInput,
  documentClientShareSchema,
  type DocumentClientShare,
  documentShareTargetsSchema,
  type DocumentShareTargets,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const documentListResponseSchema = listResponseSchema(documentWithCreatorSchema);

export class DocumentsResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListDocumentsQuery>) {
    return this.http.get('/documents', documentListResponseSchema, query);
  }
  create(input: CreateDocumentInput): Promise<Document> {
    return this.http.post('/documents', documentSchema, input);
  }
  update(id: string, input: UpdateDocumentInput): Promise<Document> {
    return this.http.patch(`/documents/${id}`, documentSchema, input);
  }
  share(id: string, input: SharePublicLinkInput) {
    return this.http.post(`/documents/${id}/share`, documentSchema, input);
  }
  unshare(id: string) {
    return this.http.delete(`/documents/${id}/share`, documentSchema);
  }
  remove(id: string) {
    return this.http.delete(`/documents/${id}`, okSchema);
  }
  /** Anonymous fetch of a publicly-shared document - used by the `/p/<slug>` reader. */
  public(slug: string): Promise<PublicDocument> {
    return this.http.get(`/public/documents/${encodeURIComponent(slug)}`, publicDocumentSchema);
  }

  // Internal sharing (DocumentAccess)
  listAccess(documentId: string) {
    return this.http.get(`/documents/${documentId}/access`, documentAccessListSchema);
  }
  addAccess(documentId: string, input: AddDocumentAccessInput): Promise<DocumentAccess> {
    return this.http.post(`/documents/${documentId}/access`, documentAccessSchema, input);
  }
  updateAccess(
    documentId: string,
    userId: string,
    input: UpdateDocumentAccessInput,
  ): Promise<DocumentAccess> {
    return this.http.patch(
      `/documents/${documentId}/access/${userId}`,
      documentAccessSchema,
      input,
    );
  }
  removeAccess(documentId: string, userId: string) {
    return this.http.delete(`/documents/${documentId}/access/${userId}`, okSchema);
  }

  // Client portal sharing: a whole client company (people go through the
  // access methods above, always READ).
  shareTargets(documentId: string): Promise<DocumentShareTargets> {
    return this.http.get(`/documents/${documentId}/share-targets`, documentShareTargetsSchema);
  }
  addClientShare(documentId: string, input: AddDocumentClientShareInput): Promise<DocumentClientShare> {
    return this.http.post(`/documents/${documentId}/client-shares`, documentClientShareSchema, input);
  }
  removeClientShare(documentId: string, clientId: string) {
    return this.http.delete(`/documents/${documentId}/client-shares/${clientId}`, okSchema);
  }
}
