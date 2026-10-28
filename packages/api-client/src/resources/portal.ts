import {
  type DeclinePublicInput,
  type PortalChangePasswordInput,
  portalContractListSchema,
  type PortalContractList,
  portalDocumentListSchema,
  type PortalDocumentList,
  portalDocumentSchema,
  type PortalDocument,
  portalInvoiceDetailSchema,
  type PortalInvoiceDetail,
  portalInvoiceListSchema,
  type PortalInvoiceList,
  portalMeSchema,
  type PortalMe,
  portalOkSchema,
  type PortalOk,
  portalOverviewSchema,
  type PortalOverview,
  portalPaymentListSchema,
  type PortalPaymentList,
  portalProjectDetailSchema,
  type PortalProjectDetail,
  portalProjectListSchema,
  type PortalProjectList,
  portalSignatureListSchema,
  type PortalSignatureList,
  publicSignatureSessionSchema,
  type PublicSignatureSession,
  type SignPublicInput,
  signPublicResponseSchema,
  type SignPublicResponse,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

/**
 * The client portal, for signed-in client people. Everything below a client
 * is addressed by that client's id; the API returns 404 for a client the
 * person is not a contact of, and 403 for billing unless they are the main
 * contact. PDFs come back through `getBlob`, never as a storage URL.
 */
export class PortalResource {
  constructor(private readonly http: HttpClient) {}

  me(): Promise<PortalMe> {
    return this.http.get('/portal/me', portalMeSchema);
  }
  changePassword(input: PortalChangePasswordInput): Promise<PortalOk> {
    return this.http.post('/portal/me/password', portalOkSchema, input);
  }

  overview(clientId: string): Promise<PortalOverview> {
    return this.http.get(`${base(clientId)}/overview`, portalOverviewSchema);
  }

  projects(clientId: string): Promise<PortalProjectList> {
    return this.http.get(`${base(clientId)}/projects`, portalProjectListSchema);
  }
  project(clientId: string, projectId: string): Promise<PortalProjectDetail> {
    return this.http.get(`${base(clientId)}/projects/${enc(projectId)}`, portalProjectDetailSchema);
  }

  documents(clientId: string): Promise<PortalDocumentList> {
    return this.http.get(`${base(clientId)}/documents`, portalDocumentListSchema);
  }
  document(clientId: string, documentId: string): Promise<PortalDocument> {
    return this.http.get(`${base(clientId)}/documents/${enc(documentId)}`, portalDocumentSchema);
  }

  signatures(clientId: string): Promise<PortalSignatureList> {
    return this.http.get(`${base(clientId)}/signatures`, portalSignatureListSchema);
  }
  signatureSession(clientId: string, signerId: string): Promise<PublicSignatureSession> {
    return this.http.get(
      `${base(clientId)}/signatures/${enc(signerId)}`,
      publicSignatureSessionSchema,
    );
  }
  signatureSourceFile(clientId: string, signerId: string) {
    return this.http.getBlob(`${base(clientId)}/signatures/${enc(signerId)}/file`);
  }
  signatureSignedFile(clientId: string, signerId: string) {
    return this.http.getBlob(`${base(clientId)}/signatures/${enc(signerId)}/signed-file`);
  }
  sign(clientId: string, signerId: string, input: SignPublicInput): Promise<SignPublicResponse> {
    return this.http.post(
      `${base(clientId)}/signatures/${enc(signerId)}/sign`,
      signPublicResponseSchema,
      input,
    );
  }
  decline(clientId: string, signerId: string, input: DeclinePublicInput): Promise<PortalOk> {
    return this.http.post(
      `${base(clientId)}/signatures/${enc(signerId)}/decline`,
      portalOkSchema,
      input,
    );
  }

  invoices(clientId: string): Promise<PortalInvoiceList> {
    return this.http.get(`${base(clientId)}/invoices`, portalInvoiceListSchema);
  }
  invoice(clientId: string, invoiceId: string): Promise<PortalInvoiceDetail> {
    return this.http.get(`${base(clientId)}/invoices/${enc(invoiceId)}`, portalInvoiceDetailSchema);
  }
  invoicePdf(clientId: string, invoiceId: string) {
    return this.http.getBlob(`${base(clientId)}/invoices/${enc(invoiceId)}/pdf`);
  }
  contracts(clientId: string): Promise<PortalContractList> {
    return this.http.get(`${base(clientId)}/contracts`, portalContractListSchema);
  }
  payments(clientId: string): Promise<PortalPaymentList> {
    return this.http.get(`${base(clientId)}/payments`, portalPaymentListSchema);
  }
}

function enc(id: string): string {
  return encodeURIComponent(id);
}

function base(clientId: string): string {
  return `/portal/clients/${enc(clientId)}`;
}
