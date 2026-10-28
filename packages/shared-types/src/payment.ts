import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY, moneyInput, rateInput, rateString } from './common/money.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { PaymentMethod } from './enums-invoice.js';
import { PaymentRegion } from './enums-finance.js';

/**
 * The single money-in record, whether the money arrived against an invoice, a
 * contract, or a milestone of one.
 *
 * THREE amount pairs, because one row answers three different questions:
 *
 *  1. "Is the contract settled?"    `amount` + `currency`. Always equal to the
 *     contract currency, so the arithmetic is single-currency and
 *     `amountPaid === totalValue` is exactly true. Only this pair moves a
 *     contract or milestone forward.
 *  2. "What hit our account?"       `receivedAmount` + `receivedCurrency` +
 *     `feeAmount`. Upwork bills the client $5,000, keeps $500, wires PKR to a
 *     local bank - all three numbers are different and all three matter.
 *  3. "What is our base revenue?"   `fxRate` + `baseAmount`, where
 *     `baseAmount = (receivedAmount - feeAmount) * fxRate`. The only field any
 *     dashboard sums.
 *
 * Consequence, and it is correct rather than a rounding bug: contracts advance
 * on GROSS while revenue reports on NET. The difference is the platform fee
 * plus FX cost.
 */
export const paymentSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  invoiceId: cuid.nullable(),
  contractId: cuid.nullable(),
  milestoneId: cuid.nullable(),
  paymentSourceId: cuid.nullable(),

  amount: decimalString,
  currency: ISO_CURRENCY,
  receivedAmount: decimalString,
  receivedCurrency: ISO_CURRENCY,
  feeAmount: decimalString,
  fxRate: rateString,
  baseAmount: decimalString,

  region: PaymentRegion,
  reference: z.string().nullable(),
  paidAt: z.coerce.date(),
  notes: z.string().nullable(),
  recordedById: cuid,
  /** Payments are voided, never deleted, so the audit trail stays visible. */
  voidedAt: z.coerce.date().nullable(),
  voidReason: z.string().nullable(),
  voidedById: cuid.nullable(),

  /** @deprecated superseded by `paymentSourceId`. Never written by the API. */
  method: PaymentMethod,
  /** @deprecated superseded by `reference`. */
  externalId: z.string().nullable(),

  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Payment = z.infer<typeof paymentSchema>;

export const paymentWithSourceSchema = paymentSchema.extend({
  paymentSource: z.object({ id: cuid, name: z.string(), kind: z.string() }).nullable(),
  recordedBy: z.object({ id: cuid, name: z.string() }).nullable(),
  contract: z.object({ id: cuid, title: z.string() }).nullable(),
  milestone: z.object({ id: cuid, title: z.string() }).nullable(),
});
export type PaymentWithSource = z.infer<typeof paymentWithSourceSchema>;

export const createPaymentSchema = z
  .object({
    contractId: cuid.optional(),
    milestoneId: cuid.optional(),
    invoiceId: cuid.optional(),

    /** In the contract currency. The server rejects a mismatch. */
    amount: moneyInput,
    currency: ISO_CURRENCY.optional(),

    /** All default to the `amount` / `currency` pair when omitted, so the
     *  common "paid exactly what we billed, no fee" case is one field. */
    receivedAmount: moneyInput.optional(),
    receivedCurrency: ISO_CURRENCY.optional(),
    feeAmount: moneyInput.optional(),
    /** Forced to 1 when `receivedCurrency` is already the org base currency. */
    fxRate: rateInput.optional(),

    paymentSourceId: cuid.optional(),
    /** Defaults from the source's `defaultRegion` when omitted. */
    region: PaymentRegion.optional(),
    reference: z.string().max(200).optional(),
    paidAt: z.coerce.date().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => v.contractId != null || v.invoiceId != null, {
    message: 'A payment must settle a contract or an invoice.',
    path: ['contractId'],
  });
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/**
 * Amounts stay editable so a typo can be corrected, but the links do not -
 * moving a payment between contracts would silently rewrite two sets of
 * totals. Void it and record a new one instead.
 */
export const updatePaymentSchema = z.object({
  amount: moneyInput.optional(),
  receivedAmount: moneyInput.optional(),
  receivedCurrency: ISO_CURRENCY.optional(),
  feeAmount: moneyInput.optional(),
  fxRate: rateInput.optional(),
  milestoneId: cuid.nullable().optional(),
  paymentSourceId: cuid.nullable().optional(),
  region: PaymentRegion.optional(),
  reference: z.string().max(200).nullable().optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export const voidPaymentSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type VoidPaymentInput = z.infer<typeof voidPaymentSchema>;

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
  contractId: cuid.optional(),
  milestoneId: cuid.optional(),
  invoiceId: cuid.optional(),
  projectId: cuid.optional(),
  clientId: cuid.optional(),
  paymentSourceId: cuid.optional(),
  region: PaymentRegion.optional(),
  currency: ISO_CURRENCY.optional(),
  paidFrom: z.coerce.date().optional(),
  paidTo: z.coerce.date().optional(),
  q: z.string().max(120).optional(),
  /** Voided rows are hidden by default but never deleted. */
  includeVoided: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
  sort: z.enum(['paidAt', 'createdAt', 'amount', 'baseAmount']).default('paidAt'),
  order: sortOrderSchema,
});
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
