import { z } from 'zod';

import { linkToken } from './common/access-code.js';
import { cuid } from './common/id.js';
import {
  SignatureEventKind,
  SignatureFieldKind,
  SignatureMethod,
  SignatureRequestStatus,
  SignerStatus,
} from './enums.js';
import { userSummarySchema } from './user.js';

/**
 * E-signature requests.
 *
 * A request freezes one PDF (rendered from a Botss document, or an uploaded
 * PDF) and collects a signature from every signer through a login-free link.
 * Field geometry is stored as fractions (0..1) of the PDF page box with the
 * origin at the TOP-LEFT, so it is independent of screen size and zoom. The
 * API maps fractions to PDF points when sealing.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * The signing-link credential: base64url of 32 random bytes (43 characters).
 * The 6-digit code from the email is a second factor sent alongside it in
 * the `x-access-code` header (see common/access-code.ts).
 */
export const signingToken = linkToken;

const fraction = z.number().min(0).max(1);

/** Box geometry shared by requester-placed and signer-placed fields. */
const fieldGeometry = z.object({
  kind: SignatureFieldKind,
  page: z.number().int().min(1).max(1000),
  x: fraction,
  y: fraction,
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.01).max(1),
});

function insidePage(f: { x: number; y: number; w: number; h: number }): boolean {
  // A hair of tolerance for floating-point drift from the drag maths.
  return f.x + f.w <= 1.0001 && f.y + f.h <= 1.0001;
}

const boundedGeometry = fieldGeometry.refine(insidePage, {
  message: 'The field must sit inside the page.',
});

export const signatureFieldSchema = z.object({
  id: cuid,
  signerId: cuid,
  kind: SignatureFieldKind,
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  placedBySigner: z.boolean(),
});
export type SignatureField = z.infer<typeof signatureFieldSchema>;

/** Never includes the token hash. */
export const signatureSignerSchema = z.object({
  id: cuid,
  email: z.string(),
  name: z.string().nullable(),
  order: z.number().int(),
  status: SignerStatus,
  viewedAt: z.coerce.date().nullable(),
  signedAt: z.coerce.date().nullable(),
  declinedAt: z.coerce.date().nullable(),
  declineReason: z.string().nullable(),
  method: SignatureMethod.nullable(),
  typedName: z.string().nullable(),
  lastEmailedAt: z.coerce.date().nullable(),
});
export type SignatureSigner = z.infer<typeof signatureSignerSchema>;

export const signatureEventSchema = z.object({
  id: cuid,
  signerId: cuid.nullable(),
  kind: SignatureEventKind,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type SignatureEvent = z.infer<typeof signatureEventSchema>;

export const signatureRequestSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  createdById: cuid,
  documentId: cuid.nullable(),
  title: z.string(),
  message: z.string().nullable(),
  status: SignatureRequestStatus,
  expiresAt: z.coerce.date(),
  sourceSha256: z.string(),
  signedSha256: z.string().nullable(),
  pageCount: z.number().int(),
  hasSignedFile: z.boolean(),
  sentAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SignatureRequest = z.infer<typeof signatureRequestSchema>;

export const signatureRequestSummarySchema = signatureRequestSchema.extend({
  createdBy: userSummarySchema,
  signers: z.array(signatureSignerSchema),
});
export type SignatureRequestSummary = z.infer<typeof signatureRequestSummarySchema>;

export const signatureRequestDetailsSchema = signatureRequestSummarySchema.extend({
  fields: z.array(signatureFieldSchema),
  events: z.array(signatureEventSchema),
});
export type SignatureRequestDetails = z.infer<typeof signatureRequestDetailsSchema>;

export const signatureRequestListSchema = z.object({
  items: z.array(signatureRequestSummarySchema),
});
export type SignatureRequestList = z.infer<typeof signatureRequestListSchema>;

// ---------------------------------------------------------------------------
// Requester inputs
// ---------------------------------------------------------------------------

export const listSignatureRequestsQuerySchema = z.object({
  documentId: cuid.optional(),
  status: SignatureRequestStatus.optional(),
});
export type ListSignatureRequestsQuery = z.infer<typeof listSignatureRequestsQuerySchema>;

const signerInput = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
  name: z.string().trim().max(120).optional(),
});

/**
 * Step 1: freeze the PDF and create a DRAFT with its signers. With only
 * `documentId`, the document is rendered to PDF. With `sourceFileId` (an
 * uploaded PDF) that file is signed instead; `documentId` may still be given
 * so the request shows up on that document's page. Fields are placed
 * afterwards on the frozen PDF (`setSignatureFieldsSchema`), then it is sent.
 */
export const createSignatureRequestSchema = z
  .object({
    documentId: cuid.optional(),
    sourceFileId: cuid.optional(),
    title: z.string().trim().min(1).max(200).optional(),
    signers: z.array(signerInput).min(1, 'Add at least one signer').max(20),
  })
  .refine((v) => Boolean(v.documentId) || Boolean(v.sourceFileId), {
    message: 'Pick either a document or an uploaded PDF.',
    path: ['documentId'],
  })
  .refine((v) => new Set(v.signers.map((s) => s.email)).size === v.signers.length, {
    message: 'Each signer needs a different email address.',
    path: ['signers'],
  });
export type CreateSignatureRequestInput = z.infer<typeof createSignatureRequestSchema>;

/** Step 2: replace the DRAFT's fields. An empty list is allowed: signers
 *  without a field place their own signature box when they sign. */
export const setSignatureFieldsSchema = z.object({
  fields: z.array(boundedGeometry.and(z.object({ signerId: cuid }))).max(200),
});
export type SetSignatureFieldsInput = z.infer<typeof setSignatureFieldsSchema>;

/** Step 3: email the signers. Rotates every signer's link. */
export const sendSignatureRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().max(2000).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(60).default(14),
});
export type SendSignatureRequestInput = z.infer<typeof sendSignatureRequestSchema>;

/**
 * Returned from send and resend. The raw links exist only here and in the
 * emails; the server keeps a hash. Shown once so the requester can share a
 * link by hand when email is slow or not configured.
 */
export const signingLinksResponseSchema = z.object({
  request: signatureRequestDetailsSchema,
  links: z.array(
    z.object({
      signerId: cuid,
      email: z.string(),
      url: z.string(),
      /** The 6-digit code (XXX-XXX) the signer types next to the link. Shown
       *  to the requester for sharing by hand, like the link itself. */
      code: z.string().optional(),
    }),
  ),
  emailed: z.boolean(),
});
export type SigningLinksResponse = z.infer<typeof signingLinksResponseSchema>;

export const cancelSignatureRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelSignatureRequestInput = z.infer<typeof cancelSignatureRequestSchema>;

// ---------------------------------------------------------------------------
// Public (signer) surface. No workspace, user or other-signer identifiers.
// ---------------------------------------------------------------------------

export const publicSignatureFieldSchema = z.object({
  id: cuid,
  kind: SignatureFieldKind,
  page: z.number().int(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
export type PublicSignatureField = z.infer<typeof publicSignatureFieldSchema>;

export const publicSignatureSessionSchema = z.object({
  title: z.string(),
  message: z.string().nullable(),
  workspaceName: z.string(),
  requesterName: z.string(),
  expiresAt: z.coerce.date(),
  requestStatus: SignatureRequestStatus,
  pageCount: z.number().int(),
  signer: z.object({
    email: z.string(),
    name: z.string().nullable(),
    status: SignerStatus,
    signedAt: z.coerce.date().nullable(),
  }),
  fields: z.array(publicSignatureFieldSchema),
  /** True when the requester placed no field for this signer, so the signer
   *  drops their own signature box. */
  canPlaceFields: z.boolean(),
  signersTotal: z.number().int(),
  signersSigned: z.number().int(),
});
export type PublicSignatureSession = z.infer<typeof publicSignatureSessionSchema>;

/** ~300 KB of PNG once base64-encoded. A signature at 2x DPR is ~20-60 KB. */
const MAX_SIGNATURE_DATA_URL = 420_000;

export const signPublicSchema = z
  .object({
    consent: z.literal(true, {
      errorMap: () => ({ message: 'Please agree to sign electronically.' }),
    }),
    method: SignatureMethod,
    /** The signature as a PNG. Typed signatures are rendered to PNG by the
     *  signing page so the sealed PDF shows exactly what the signer saw. */
    imageDataUrl: z
      .string()
      .max(MAX_SIGNATURE_DATA_URL, 'The signature image is too large.')
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'The signature must be a PNG image.'),
    typedName: z.string().trim().min(2).max(120).optional(),
    signerName: z.string().trim().min(1).max(120).optional(),
    /** Only honoured when the requester placed no field for this signer. */
    fields: z.array(boundedGeometry).max(20).optional(),
  })
  .refine((v) => v.method !== 'TYPED' || Boolean(v.typedName), {
    message: 'Type your name to sign.',
    path: ['typedName'],
  });
export type SignPublicInput = z.infer<typeof signPublicSchema>;

export const signPublicResponseSchema = z.object({
  status: SignerStatus,
  allSigned: z.boolean(),
});
export type SignPublicResponse = z.infer<typeof signPublicResponseSchema>;

export const declinePublicSchema = z.object({
  reason: z.string().trim().min(1, 'Tell the sender why you are declining.').max(500),
});
export type DeclinePublicInput = z.infer<typeof declinePublicSchema>;

/** The consent sentence, shared so the page and the certificate agree. */
export const SIGNATURE_CONSENT_TEXT =
  'I agree to sign this document electronically, and I intend my electronic signature to have the same effect as a handwritten signature.';
