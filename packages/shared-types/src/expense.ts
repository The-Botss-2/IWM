import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY, moneyInput, rateInput, rateString } from './common/money.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import { ExpenseCategory } from './enums-finance.js';

/**
 * Money out.
 *
 * Simpler than `Payment` on purpose: an expense has no "settles a contract in
 * that contract's currency" question, so it needs only `amount`/`currency`
 * plus the `fxRate`/`baseAmount` reporting pair.
 *
 * This is the only cost basis the schema has - there is no rate field on User,
 * Project or Client, so labour cost cannot be derived from time entries.
 * Project P&L is `SUM(payment.baseAmount) - SUM(expense.baseAmount)`.
 */
export const expenseSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  /** Null means company overhead rather than a project cost. */
  projectId: cuid.nullable(),
  contractId: cuid.nullable(),
  category: ExpenseCategory,
  vendor: z.string().nullable(),
  description: z.string().min(1).max(500),
  amount: decimalString,
  currency: ISO_CURRENCY,
  fxRate: rateString,
  baseAmount: decimalString,
  paymentSourceId: cuid.nullable(),
  incurredAt: z.coerce.date(),
  reference: z.string().nullable(),
  receiptFileId: cuid.nullable(),
  recordedById: cuid,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Expense = z.infer<typeof expenseSchema>;

export const expenseWithRefsSchema = expenseSchema.extend({
  project: z.object({ id: cuid, name: z.string() }).nullable(),
  contract: z.object({ id: cuid, title: z.string() }).nullable(),
  paymentSource: z.object({ id: cuid, name: z.string() }).nullable(),
  receipt: z
    .object({ id: cuid, filename: z.string(), url: z.string().nullable() })
    .nullable(),
  recordedBy: z.object({ id: cuid, name: z.string() }).nullable(),
  /** Recorded by a payroll run: edit or delete it through the run, not here. */
  fromPayroll: z.boolean(),
});
export type ExpenseWithRefs = z.infer<typeof expenseWithRefsSchema>;

export const createExpenseSchema = z.object({
  projectId: cuid.optional(),
  contractId: cuid.optional(),
  category: ExpenseCategory.optional(),
  vendor: z.string().max(200).optional(),
  description: z.string().min(1).max(500),
  amount: moneyInput,
  currency: ISO_CURRENCY.optional(),
  /** Forced to 1 when `currency` is already the org base currency. */
  fxRate: rateInput.optional(),
  paymentSourceId: cuid.optional(),
  incurredAt: z.coerce.date().optional(),
  reference: z.string().max(200).optional(),
  receiptFileId: cuid.optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = createExpenseSchema.partial().extend({
  projectId: cuid.nullable().optional(),
  contractId: cuid.nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
  paymentSourceId: cuid.nullable().optional(),
  reference: z.string().max(200).nullable().optional(),
  receiptFileId: cuid.nullable().optional(),
});
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const listExpensesQuerySchema = paginationQuerySchema.extend({
  projectId: cuid.optional(),
  contractId: cuid.optional(),
  category: ExpenseCategory.optional(),
  paymentSourceId: cuid.optional(),
  currency: ISO_CURRENCY.optional(),
  incurredFrom: z.coerce.date().optional(),
  incurredTo: z.coerce.date().optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(['incurredAt', 'createdAt', 'amount', 'baseAmount']).default('incurredAt'),
  order: sortOrderSchema,
});
export type ListExpensesQuery = z.infer<typeof listExpensesQuerySchema>;
