import { z } from 'zod';
import {
  ACCESS_CODE_HEADER,
  type CancelSignatureRequestInput,
  type CreateSignatureRequestInput,
  type DeclinePublicInput,
  type ListSignatureRequestsQuery,
  type PublicSignatureSession,
  publicSignatureSessionSchema,
  type SendSignatureRequestInput,
  type SetSignatureFieldsInput,
  type SignatureRequestDetails,
  signatureRequestDetailsSchema,
  type SignatureRequestList,
  signatureRequestListSchema,
  type SigningLinksResponse,
  signingLinksResponseSchema,
  type SignPublicInput,
  type SignPublicResponse,
  signPublicResponseSchema,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });

/**
 * E-signature requests. The requester methods need a session; the `public*`
 * methods authenticate with the signing token in the path and are what the
 * `/sign/<token>` page uses.
 *
 * PDFs come back through `getBlob` (credentialed fetch), never as a URL for
 * an `<a href>`: see the note on `HttpClient.getBlob`.
 */
export class SignaturesResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListSignatureRequestsQuery>): Promise<SignatureRequestList> {
    return this.http.get('/signatures', signatureRequestListSchema, query);
  }
  create(input: CreateSignatureRequestInput): Promise<SignatureRequestDetails> {
    return this.http.post('/signatures', signatureRequestDetailsSchema, input);
  }
  setFields(id: string, input: SetSignatureFieldsInput): Promise<SignatureRequestDetails> {
    return this.http.put(
      `/signatures/${encodeURIComponent(id)}/fields`,
      signatureRequestDetailsSchema,
      input,
    );
  }
  send(id: string, input: Partial<SendSignatureRequestInput>): Promise<SigningLinksResponse> {
    return this.http.post(`/signatures/${encodeURIComponent(id)}/send`, signingLinksResponseSchema, input);
  }
  resend(id: string, signerId: string): Promise<SigningLinksResponse> {
    return this.http.post(
      `/signatures/${encodeURIComponent(id)}/signers/${encodeURIComponent(signerId)}/resend`,
      signingLinksResponseSchema,
      {},
    );
  }
  cancel(id: string, input: CancelSignatureRequestInput = {}): Promise<SignatureRequestDetails> {
    return this.http.post(`/signatures/${encodeURIComponent(id)}/cancel`, signatureRequestDetailsSchema, input);
  }
  retrySeal(id: string): Promise<SignatureRequestDetails> {
    return this.http.post(`/signatures/${encodeURIComponent(id)}/seal`, signatureRequestDetailsSchema, {});
  }
  /** Discard a request that was never sent. */
  removeDraft(id: string) {
    return this.http.delete(`/signatures/${encodeURIComponent(id)}`, okSchema);
  }
  /** The frozen PDF the signers see. */
  sourceFile(id: string) {
    return this.http.getBlob(`/signatures/${encodeURIComponent(id)}/file`);
  }
  /** The sealed PDF with signatures and the certificate page. */
  signedFile(id: string) {
    return this.http.getBlob(`/signatures/${encodeURIComponent(id)}/signed-file`);
  }

  // Signer side ------------------------------------------------------------

  // Every public call carries the link token (path) and the 6-digit code the
  // signer typed (header). A wrong code answers 401 `signing-code-invalid`,
  // too many wrong codes 423 `signing-code-locked`.

  publicSession(token: string, code: string): Promise<PublicSignatureSession> {
    return this.http.get(
      `/public/signatures/${encodeURIComponent(token)}`,
      publicSignatureSessionSchema,
      undefined,
      codeHeader(code),
    );
  }
  publicSourceFile(token: string, code: string) {
    return this.http.getBlob(
      `/public/signatures/${encodeURIComponent(token)}/file`,
      undefined,
      codeHeader(code),
    );
  }
  publicSignedFile(token: string, code: string) {
    return this.http.getBlob(
      `/public/signatures/${encodeURIComponent(token)}/signed-file`,
      undefined,
      codeHeader(code),
    );
  }
  publicSign(token: string, code: string, input: SignPublicInput): Promise<SignPublicResponse> {
    return this.http.post(
      `/public/signatures/${encodeURIComponent(token)}/sign`,
      signPublicResponseSchema,
      input,
      codeHeader(code),
    );
  }
  publicDecline(token: string, code: string, input: DeclinePublicInput) {
    return this.http.post(
      `/public/signatures/${encodeURIComponent(token)}/decline`,
      okSchema,
      input,
      codeHeader(code),
    );
  }
}

function codeHeader(code: string): Record<string, string> {
  return { [ACCESS_CODE_HEADER]: code };
}
