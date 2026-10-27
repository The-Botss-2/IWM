import { z } from 'zod';

import { cuid } from './common/id.js';
// Money primitives live in common/money.js so invoice, contract, payment and
// expense all validate amounts the same way. They used to be private consts
// in this file, which is how the leads surface ended up with its own copy.
import { decimalString, ISO_CURRENCY, rateInput } from './common/money.js';
import { InvoiceStatus } from './enums-invoice.js';

export const invoiceLineItemSchema = z.object({
  id: cuid,
  invoiceId: cuid,
  position: z.number().int().nonnegative(),
  description: z.string().min(1).max(500),
  quantity: decimalString,
  unitPrice: decimalString,
  taxRate: decimalString,
  discountRate: decimalString,
  amount: decimalString,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type InvoiceLineItem = z.infer<typeof invoiceLineItemSchema>;

// `paymentSchema` moved to ./payment.js - Payment is now the single
// money-in record and is no longer owned by Invoice.
import { paymentSchema } from './payment.js';

export const invoiceSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  clientId: cuid,
  projectId: cuid.nullable(),
  createdById: cuid,
  number: z.string(),
  status: InvoiceStatus,
  currency: ISO_CURRENCY,
  issuedAt: z.coerce.date(),
  dueAt: z.coerce.date(),
  subtotal: decimalString,
  discountAmount: decimalString,
  taxAmount: decimalString,
  total: decimalString,
  amountPaid: decimalString,
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  footer: z.string().nullable(),
  /// An invoice is a DOCUMENT raised against a contract or one of its
  /// milestones. The contract, not the invoice, is the root money object.
  contractId: cuid.nullable(),
  milestoneId: cuid.nullable(),
  pdfFileId: cuid.nullable(),
  /** Folder name under apps/api/invoice-templates; null = organization default. */
  templateKey: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const invoiceWithItemsSchema = invoiceSchema.extend({
  lineItems: z.array(invoiceLineItemSchema),
  payments: z.array(paymentSchema),
});
export type InvoiceWithItems = z.infer<typeof invoiceWithItemsSchema>;

const createLineItemInputSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.union([z.string(), z.number()]).optional(),
  unitPrice: z.union([z.string(), z.number()]).optional(),
  taxRate: z.union([z.string(), z.number()]).optional(),
  discountRate: z.union([z.string(), z.number()]).optional(),
});
export type CreateLineItemInput = z.infer<typeof createLineItemInputSchema>;

export const createInvoiceSchema = z.object({
  clientId: cuid,
  projectId: cuid.optional(),
  contractId: cuid.optional(),
  milestoneId: cuid.optional(),
  currency: ISO_CURRENCY.optional(),
  issuedAt: z.coerce.date().optional(),
  dueAt: z.coerce.date(),
  lineItems: z.array(createLineItemInputSchema).min(1),
  notes: z.string().max(2000).optional(),
  terms: z.string().max(2000).optional(),
  footer: z.string().max(500).optional(),
  templateKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/).optional(),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z.object({
  clientId: cuid.optional(),
  projectId: cuid.nullable().optional(),
  contractId: cuid.nullable().optional(),
  milestoneId: cuid.nullable().optional(),
  currency: ISO_CURRENCY.optional(),
  issuedAt: z.coerce.date().optional(),
  dueAt: z.coerce.date().optional(),
  lineItems: z.array(createLineItemInputSchema).min(1).optional(),
  notes: z.string().max(2000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional(),
  footer: z.string().max(500).nullable().optional(),
  templateKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,48}$/).nullable().optional(),
});
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const listInvoicesQuerySchema = z.object({
  status: InvoiceStatus.optional(),
  clientId: cuid.optional(),
  projectId: cuid.optional(),
  q: z.string().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const recordPaymentSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  receivedAmount: z.union([z.string(), z.number()]).optional(),
  receivedCurrency: ISO_CURRENCY.optional(),
  feeAmount: z.union([z.string(), z.number()]).optional(),
  fxRate: rateInput.optional(),
  paymentSourceId: cuid.optional(),
  reference: z.string().max(200).optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().max(500).optional(),
});
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * Manual status change. Only the transitions a person decides on: PAID and
 * PARTIALLY_PAID follow recorded payments, so "mark as paid" records a payment
 * instead of setting the status directly.
 */
export const setInvoiceStatusSchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'CANCELLED']),
});
export type SetInvoiceStatusInput = z.infer<typeof setInvoiceStatusSchema>;
