import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY } from './common/money.js';
import { DocumentVisibility } from './enums.js';
import { customFieldValueSchema } from './custom-field.js';
import { documentViewerPermissionSchema } from './document.js';
import { signatureRequestSummarySchema } from './signature.js';
import { userSummarySchema } from './user.js';

/**
 * The client hub: everything about one client on the client page. Staff-side
 * only (never a portal schema). New response fields are optional rather than
 * defaulted so the SDK's input and output types stay identical.
 */

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

/** Opaque cursor from a previous page's `nextCursor`. */
export const clientHubCursor = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);

export const clientHubPageQuerySchema = z.object({
  cursor: clientHubCursor.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type ClientHubPageQuery = z.infer<typeof clientHubPageQuerySchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * Why a document shows up on the client page:
 * FILED   - filed under the client (Document.clientId),
 * PROJECT - lives in one of the client's projects,
 * SHARED  - shared with the client company or with one of its portal people.
 */
export const ClientDocumentLink = z.enum(['FILED', 'PROJECT', 'SHARED']);
export type ClientDocumentLink = z.infer<typeof ClientDocumentLink>;

export const clientDocumentSchema = z.object({
  id: cuid,
  title: z.string(),
  icon: z.string().nullable(),
  visibility: DocumentVisibility,
  clientId: cuid.nullable(),
  projectId: cuid.nullable(),
  /** Null when the document has no project. `name` is null when the project
   *  is PRIVATE and the viewer may not see it. */
  project: z.object({ id: cuid, name: z.string().nullable() }).nullable(),
  createdBy: userSummarySchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  /** Strongest reason first: FILED, then PROJECT, then SHARED. */
  link: ClientDocumentLink,
  links: z.array(ClientDocumentLink),
  /** Shared with the whole client company (every portal person). */
  sharedWithClient: z.boolean(),
  /** Personal READ grants held by this client's portal people. */
  sharedWithPeopleCount: z.number().int().nonnegative(),
  viewerPermission: documentViewerPermissionSchema,
  /** May this viewer share / stop sharing it (owner or workspace admin). */
  canManageShare: z.boolean(),
});
export type ClientDocument = z.infer<typeof clientDocumentSchema>;

export const clientDocumentListSchema = z.object({
  items: z.array(clientDocumentSchema),
  /** True when more documents exist than the list returns. */
  hasMore: z.boolean(),
});
export type ClientDocumentList = z.infer<typeof clientDocumentListSchema>;

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const clientSignatureItemSchema = signatureRequestSummarySchema.extend({
  document: z.object({ id: cuid, title: z.string() }).nullable(),
});
export type ClientSignatureItem = z.infer<typeof clientSignatureItemSchema>;

export const clientSignatureListSchema = z.object({
  items: z.array(clientSignatureItemSchema),
  nextCursor: clientHubCursor.nullable(),
});
export type ClientSignatureList = z.infer<typeof clientSignatureListSchema>;

// ---------------------------------------------------------------------------
// Billing summary (finance roles only)
// ---------------------------------------------------------------------------

/**
 * One currency's totals. Currencies are never mixed or converted.
 * Invoice and contract figures are separate views of the same money (an
 * invoice is often raised against a contract), so they are never summed.
 * `received` sums live (non-voided) payments in the currency they settle.
 */
export const clientBillingCurrencySchema = z.object({
  currency: ISO_CURRENCY,
  /** Issued invoices (not draft, not cancelled). */
  invoiced: decimalString,
  invoicePaid: decimalString,
  /** Still owed on open invoices (sent, partially paid, overdue). */
  invoiceOutstanding: decimalString,
  /** Active and completed contracts. */
  contracted: decimalString,
  contractOutstanding: decimalString,
  received: decimalString,
});
export type ClientBillingCurrency = z.infer<typeof clientBillingCurrencySchema>;

export const clientBillingSummarySchema = z.object({
  clientId: cuid,
  byCurrency: z.array(clientBillingCurrencySchema),
  counts: z.object({
    invoices: z.number().int().nonnegative(),
    openInvoices: z.number().int().nonnegative(),
    overdueInvoices: z.number().int().nonnegative(),
    contracts: z.number().int().nonnegative(),
    payments: z.number().int().nonnegative(),
  }),
});
export type ClientBillingSummary = z.infer<typeof clientBillingSummarySchema>;

// ---------------------------------------------------------------------------
// Activity feed (derived from existing tables)
// ---------------------------------------------------------------------------

export const ClientActivityKind = z.enum([
  'CLIENT_CREATED',
  'LEAD_CONVERTED',
  'PROJECT_CREATED',
  'DOCUMENT_FILED',
  'DOCUMENT_SHARED',
  'PORTAL_INVITED',
  'PORTAL_REVOKED',
  'PORTAL_ROLE_CHANGED',
  'SIGNATURE_SENT',
  'SIGNATURE_COMPLETED',
  'INVOICE_ISSUED',
  'PAYMENT_RECEIVED',
  'CONTRACT_CREATED',
]);
export type ClientActivityKind = z.infer<typeof ClientActivityKind>;

export const ClientActivityEntityType = z.enum([
  'client',
  'lead',
  'project',
  'document',
  'signature',
  'invoice',
  'payment',
  'contract',
  'portal_contact',
]);
export type ClientActivityEntityType = z.infer<typeof ClientActivityEntityType>;

export const clientActivityItemSchema = z.object({
  /** Stable, unique across kinds. */
  id: z.string(),
  kind: ClientActivityKind,
  at: z.coerce.date(),
  actor: z.object({ id: cuid, name: z.string() }).nullable(),
  /** Short label of the thing acted on (document title, invoice number...). */
  title: z.string(),
  /** Extra context, e.g. "USD 1200.00" or a portal person's email. */
  detail: z.string().nullable(),
  entity: z.object({ type: ClientActivityEntityType, id: z.string() }).nullable(),
});
export type ClientActivityItem = z.infer<typeof clientActivityItemSchema>;

export const clientActivityListSchema = z.object({
  items: z.array(clientActivityItemSchema),
  nextCursor: clientHubCursor.nullable(),
});
export type ClientActivityList = z.infer<typeof clientActivityListSchema>;

// ---------------------------------------------------------------------------
// Custom fields (CLIENT-scoped definitions, values on one client)
// ---------------------------------------------------------------------------

export const clientCustomFieldValueListSchema = z.object({
  items: z.array(customFieldValueSchema),
});
export type ClientCustomFieldValueList = z.infer<typeof clientCustomFieldValueListSchema>;

export const setClientCustomFieldSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
});
export type SetClientCustomFieldInput = z.infer<typeof setClientCustomFieldSchema>;

export const clientHubOkSchema = z.object({ ok: z.literal(true) });
export type ClientHubOk = z.infer<typeof clientHubOkSchema>;
