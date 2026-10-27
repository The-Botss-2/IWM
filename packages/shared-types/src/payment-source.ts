import { z } from 'zod';

import { decimalString } from './common/money.js';
import { cuid } from './common/id.js';
import { PaymentRegion, PaymentSourceKind } from './enums-finance.js';

/**
 * A rail money moves through: Upwork, IBFT, Wise, Remitly, cash.
 *
 * Scoped to the ORGANISATION rather than the workspace - "we get paid through
 * Upwork" is a company fact, and making the finance manager rebuild the list
 * per workspace would be busywork.
 */
export const paymentSourceSchema = z.object({
  id: cuid,
  organizationId: cuid,
  name: z.string().min(1).max(80),
  kind: PaymentSourceKind,
  /** Null means "ask every time" - some rails are used both ways. */
  defaultRegion: PaymentRegion.nullable(),
  /** Prefills the fee field on the payment form. Null means no default. */
  defaultFeePercent: decimalString.nullable(),
  isActive: z.boolean(),
  position: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type PaymentSource = z.infer<typeof paymentSourceSchema>;

/** List row, with the reference count that decides deactivate-vs-delete. */
export const paymentSourceWithUsageSchema = paymentSourceSchema.extend({
  usageCount: z.number().int().nonnegative(),
});
export type PaymentSourceWithUsage = z.infer<typeof paymentSourceWithUsageSchema>;

export const createPaymentSourceSchema = z.object({
  name: z.string().min(1).max(80),
  kind: PaymentSourceKind.optional(),
  defaultRegion: PaymentRegion.nullable().optional(),
  defaultFeePercent: z.union([z.string(), z.number()]).nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});
export type CreatePaymentSourceInput = z.infer<typeof createPaymentSourceSchema>;

export const updatePaymentSourceSchema = createPaymentSourceSchema
  .partial()
  .extend({ isActive: z.boolean().optional() });
export type UpdatePaymentSourceInput = z.infer<typeof updatePaymentSourceSchema>;

export const reorderPaymentSourcesSchema = z.object({
  ids: z.array(cuid).min(1).max(200),
});
export type ReorderPaymentSourcesInput = z.infer<typeof reorderPaymentSourcesSchema>;

export const listPaymentSourcesQuerySchema = z.object({
  /** Inactive rails stay selectable on historical records but are hidden by
   *  default in the payment form. */
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => v === true || v === 'true')
    .optional(),
});
export type ListPaymentSourcesQuery = z.infer<typeof listPaymentSourcesQuerySchema>;
