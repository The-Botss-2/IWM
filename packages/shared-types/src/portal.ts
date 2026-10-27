import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY } from './common/money.js';
import { BillingModel, ContractStatus, MilestoneStatus, PaymentStatus } from './enums-finance.js';
import { InvoiceStatus } from './enums-invoice.js';
import { ProjectStatus, SignatureRequestStatus, SignerStatus, TaskStatus } from './enums.js';

/* eslint-disable @typescript-eslint/no-redeclare -- value/type pairs share names by design */

/**
 * Client portal. People at our clients sign in with a CLIENT account and see
 * only their own client's projects, shared documents, signature requests and
 * (the main contact) billing.
 *
 * Every portal output schema below is an ALLOWLIST: `z.object` strips unknown
 * keys, so an over-selected internal column (notes, FX, fees, assignees)
 * cannot reach a client even if a query returns it. Add a field here only if
 * the client should see it.
 */

/** Mirrors `prisma.ClientContactRole`. PRIMARY is the main contact. */
export const ClientContactRole = z.enum(['PRIMARY', 'MEMBER']);
export type ClientContactRole = z.infer<typeof ClientContactRole>;

// ============================================================================
// Staff side: who can use a client's portal
// ============================================================================

/** PENDING until the person has set a password. */
export const ClientContactStatus = z.enum(['PENDING', 'ACTIVE']);
export type ClientContactStatus = z.infer<typeof ClientContactStatus>;

export const clientContactSchema = z.object({
  id: cuid,
  clientId: cuid,
  role: ClientContactRole,
  status: ClientContactStatus,
  /** No `image`: it is client-controlled and would load in staff browsers. */
  user: z.object({ id: cuid, name: z.string(), email: z.string().email() }),
  invitedBy: z.object({ id: cuid, name: z.string() }).nullable(),
  lastSeenAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ClientContact = z.infer<typeof clientContactSchema>;

export const clientContactListSchema = z.object({
  items: z.array(clientContactSchema),
  /** Whether the viewer may invite, reset, re-rank and revoke (workspace
   *  owners, admins and org admins). A UX hint; the API enforces it. */
  canManage: z.boolean(),
});
export type ClientContactList = z.infer<typeof clientContactListSchema>;

export const inviteClientContactSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  /** Falls back to the local part of the email. */
  name: z.string().trim().min(1).max(100).optional(),
  role: ClientContactRole.default('MEMBER'),
});
export type InviteClientContactInput = z.infer<typeof inviteClientContactSchema>;

export const updateClientContactSchema = z.object({
  role: ClientContactRole,
});
export type UpdateClientContactInput = z.infer<typeof updateClientContactSchema>;

/**
 * Invite, resend and reset responses. `link` is the one-time URL, returned so
 * staff can copy it when mail is slow or down; null when no link was needed
 * (the person already has a password and just got a notice). `emailed` is
 * false when no mail transport is configured.
 */
export const clientContactLinkResponseSchema = z.object({
  contact: clientContactSchema,
  link: z.string().url().nullable(),
  /** When `link` stops working; null when there is no link. */
  linkExpiresAt: z.coerce.date().nullable().optional(),
  emailed: z.boolean(),
});
export type ClientContactLinkResponse = z.infer<typeof clientContactLinkResponseSchema>;

// ============================================================================
// Staff side: what a client sees of a project
// ============================================================================

export const updateProjectPortalSchema = z
  .object({
    portalVisible: z.boolean().optional(),
    portalShowAllTasks: z.boolean().optional(),
  })
  .refine((v) => v.portalVisible !== undefined || v.portalShowAllTasks !== undefined, {
    message: 'Nothing to update.',
  });
export type UpdateProjectPortalInput = z.infer<typeof updateProjectPortalSchema>;

export const projectPortalSettingsSchema = z.object({
  id: cuid,
  portalVisible: z.boolean(),
  portalShowAllTasks: z.boolean(),
});
export type ProjectPortalSettings = z.infer<typeof projectPortalSettingsSchema>;

export const updateTaskPortalVisibilitySchema = z.object({
  portalVisible: z.boolean(),
});
export type UpdateTaskPortalVisibilityInput = z.infer<typeof updateTaskPortalVisibilitySchema>;

export const taskPortalVisibilitySchema = z.object({
  id: cuid,
  portalVisible: z.boolean(),
});
export type TaskPortalVisibility = z.infer<typeof taskPortalVisibilitySchema>;

// ============================================================================
// Portal: the signed-in client person
// ============================================================================

export const portalClientSummarySchema = z.object({
  id: cuid,
  name: z.string(),
  role: ClientContactRole,
  /** Main contact only: invoices, contracts and payments. */
  canSeeBilling: z.boolean(),
  /** The company running the portal (us), for the header. */
  agency: z.object({
    name: z.string(),
    logoUrl: z.string().nullable(),
  }),
});
export type PortalClientSummary = z.infer<typeof portalClientSummarySchema>;

export const portalMeSchema = z.object({
  user: z.object({ id: cuid, name: z.string(), email: z.string().email() }),
  clients: z.array(portalClientSummarySchema),
});
export type PortalMe = z.infer<typeof portalMeSchema>;

/** Client people change their own password here, never through Better Auth. */
export const portalChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(128),
});
export type PortalChangePasswordInput = z.infer<typeof portalChangePasswordSchema>;

export const portalOkSchema = z.object({ ok: z.literal(true) });
export type PortalOk = z.infer<typeof portalOkSchema>;

export const portalOutstandingSchema = z.object({
  currency: ISO_CURRENCY,
  amount: decimalString,
  invoiceCount: z.number().int(),
});
export type PortalOutstanding = z.infer<typeof portalOutstandingSchema>;

// ============================================================================
// Portal: projects and progress
// ============================================================================

/**
 * Task counts for one project, over every task (subtasks included), exactly
 * as the internal project summary counts them, so staff and client always
 * see the same `percent` = done / total.
 */
export const portalProgressSchema = z.object({
  total: z.number().int(),
  notStarted: z.number().int(),
  inProgress: z.number().int(),
  inReview: z.number().int(),
  done: z.number().int(),
  cancelled: z.number().int(),
  percent: z.number().int().min(0).max(100),
});
export type PortalProgress = z.infer<typeof portalProgressSchema>;

export const portalProjectSummarySchema = z.object({
  id: cuid,
  name: z.string(),
  status: ProjectStatus,
  color: z.string().nullable(),
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  progress: portalProgressSchema,
});
export type PortalProjectSummary = z.infer<typeof portalProjectSummarySchema>;

export const portalProjectListSchema = z.object({
  items: z.array(portalProjectSummarySchema),
});
export type PortalProjectList = z.infer<typeof portalProjectListSchema>;

export const portalMilestoneSchema = z.object({
  id: cuid,
  title: z.string(),
  status: MilestoneStatus,
  dueDate: z.coerce.date().nullable(),
  deliveredAt: z.coerce.date().nullable(),
  /** Main contact only; null for everyone else. */
  amount: decimalString.nullable(),
  currency: ISO_CURRENCY.nullable(),
  paymentStatus: PaymentStatus.nullable(),
});
export type PortalMilestone = z.infer<typeof portalMilestoneSchema>;

export const portalTaskSchema = z.object({
  id: cuid,
  title: z.string(),
  status: TaskStatus,
  startDate: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});
export type PortalTask = z.infer<typeof portalTaskSchema>;

export const portalProjectDetailSchema = portalProjectSummarySchema.extend({
  milestones: z.array(portalMilestoneSchema),
  /** MARKED lists only tasks the team switched on; ALL lists every task. */
  taskMode: z.enum(['MARKED', 'ALL']),
  tasks: z.array(portalTaskSchema),
});
export type PortalProjectDetail = z.infer<typeof portalProjectDetailSchema>;

// ============================================================================
// Portal: documents (read-only)
// ============================================================================

export const portalDocumentSummarySchema = z.object({
  id: cuid,
  title: z.string(),
  icon: z.string().nullable(),
  updatedAt: z.coerce.date(),
  /** How it reached them. COMPANY wins when it was shared both ways. */
  sharedWith: z.enum(['COMPANY', 'PERSON']),
});
export type PortalDocumentSummary = z.infer<typeof portalDocumentSummarySchema>;

export const portalDocumentListSchema = z.object({
  items: z.array(portalDocumentSummarySchema),
});
export type PortalDocumentList = z.infer<typeof portalDocumentListSchema>;

export const portalDocumentSchema = z.object({
  id: cuid,
  title: z.string(),
  icon: z.string().nullable(),
  coverUrl: z.string().nullable(),
  /** Tiptap JSON, rendered read-only. */
  content: z.unknown(),
  authorName: z.string(),
  updatedAt: z.coerce.date(),
});
export type PortalDocument = z.infer<typeof portalDocumentSchema>;

// ============================================================================
// Portal: e-signatures addressed to the signed-in person
// ============================================================================

export const portalSignatureItemSchema = z.object({
  /** The person's own signer row; the portal signs by this id. */
  signerId: cuid,
  title: z.string(),
  requesterName: z.string(),
  requestStatus: SignatureRequestStatus,
  signerStatus: SignerStatus,
  sentAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date(),
  signedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});
export type PortalSignatureItem = z.infer<typeof portalSignatureItemSchema>;

export const portalSignatureListSchema = z.object({
  items: z.array(portalSignatureItemSchema),
});
export type PortalSignatureList = z.infer<typeof portalSignatureListSchema>;

// ============================================================================
// Portal: overview
// ============================================================================

export const portalOverviewSchema = z.object({
  projects: z.array(portalProjectSummarySchema),
  /** Requests waiting for this person's signature. */
  pendingSignatures: z.number().int(),
  sharedDocuments: z.number().int(),
  /** Main contact only; null otherwise. One row per currency, never mixed. */
  outstanding: z.array(portalOutstandingSchema).nullable(),
});
export type PortalOverview = z.infer<typeof portalOverviewSchema>;

// ============================================================================
// Portal: billing (main contact only)
// ============================================================================

export const portalInvoiceSummarySchema = z.object({
  id: cuid,
  number: z.string(),
  status: InvoiceStatus,
  currency: ISO_CURRENCY,
  issuedAt: z.coerce.date(),
  dueAt: z.coerce.date(),
  total: decimalString,
  amountPaid: decimalString,
  balance: decimalString,
  projectName: z.string().nullable(),
});
export type PortalInvoiceSummary = z.infer<typeof portalInvoiceSummarySchema>;

export const portalInvoiceListSchema = z.object({
  items: z.array(portalInvoiceSummarySchema),
});
export type PortalInvoiceList = z.infer<typeof portalInvoiceListSchema>;

export const portalInvoiceLineSchema = z.object({
  id: cuid,
  description: z.string(),
  quantity: decimalString,
  unitPrice: decimalString,
  taxRate: decimalString,
  discountRate: decimalString,
  amount: decimalString,
});
export type PortalInvoiceLine = z.infer<typeof portalInvoiceLineSchema>;

/** Exactly what the invoice PDF already prints, nothing more. */
export const portalInvoiceDetailSchema = portalInvoiceSummarySchema.extend({
  subtotal: decimalString,
  discountAmount: decimalString,
  taxAmount: decimalString,
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  footer: z.string().nullable(),
  contractTitle: z.string().nullable(),
  lineItems: z.array(portalInvoiceLineSchema),
});
export type PortalInvoiceDetail = z.infer<typeof portalInvoiceDetailSchema>;

export const portalContractMilestoneSchema = z.object({
  id: cuid,
  title: z.string(),
  amount: decimalString,
  amountPaid: decimalString,
  status: MilestoneStatus,
  paymentStatus: PaymentStatus,
  dueDate: z.coerce.date().nullable(),
  deliveredAt: z.coerce.date().nullable(),
});
export type PortalContractMilestone = z.infer<typeof portalContractMilestoneSchema>;

/** No notes, no FX rate, no base-currency values, no expenses. */
export const portalContractSchema = z.object({
  id: cuid,
  title: z.string(),
  billingModel: BillingModel,
  status: ContractStatus,
  currency: ISO_CURRENCY,
  totalValue: decimalString,
  amountPaid: decimalString,
  balance: decimalString,
  paymentStatus: PaymentStatus,
  startDate: z.coerce.date().nullable(),
  endDate: z.coerce.date().nullable(),
  projectName: z.string().nullable(),
  milestones: z.array(portalContractMilestoneSchema),
});
export type PortalContract = z.infer<typeof portalContractSchema>;

export const portalContractListSchema = z.object({
  items: z.array(portalContractSchema),
});
export type PortalContractList = z.infer<typeof portalContractListSchema>;

/** Gross settled amount only: no reference, fee, received amount or FX. */
export const portalPaymentSchema = z.object({
  id: cuid,
  amount: decimalString,
  currency: ISO_CURRENCY,
  paidAt: z.coerce.date(),
  invoiceNumber: z.string().nullable(),
  contractTitle: z.string().nullable(),
});
export type PortalPayment = z.infer<typeof portalPaymentSchema>;

export const portalPaymentListSchema = z.object({
  items: z.array(portalPaymentSchema),
});
export type PortalPaymentList = z.infer<typeof portalPaymentListSchema>;
