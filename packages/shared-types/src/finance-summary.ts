import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY } from './common/money.js';
import { ExpenseCategory, PaymentRegion } from './enums-finance.js';

export const financeSummaryQuerySchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  projectId: cuid.optional(),
  clientId: cuid.optional(),
});
export type FinanceSummaryQuery = z.infer<typeof financeSummaryQuerySchema>;

/**
 * The landing view of the Financials tab. Every field answers one of the
 * finance manager's four standing questions: did money come in this period,
 * who still owes us, which rail is it arriving through, and how much of it is
 * local vs international.
 *
 * Every `*Base` figure is denominated in `baseCurrency`. Note the deliberate
 * asymmetry: `outstandingBase` uses each contract's BOOKED rate
 * (`fxRateToBase`), while `receivedBase` uses each payment's REALIZED rate.
 * That is standard booked-vs-realized accounting, not a rounding bug.
 */
export const financeSummarySchema = z.object({
  baseCurrency: ISO_CURRENCY,
  range: z.object({ from: z.coerce.date(), to: z.coerce.date() }),

  // --- money in, this period ---
  /** Net of platform fees. This is revenue. */
  receivedBase: decimalString,
  /** Before fees. `receivedGrossBase - receivedBase` is the fee cost, which is
   *  invisible otherwise and is often the biggest controllable expense. */
  receivedGrossBase: decimalString,
  paymentCount: z.number().int().nonnegative(),

  // --- money out, this period ---
  spentBase: decimalString,
  expenseCount: z.number().int().nonnegative(),
  netProfitBase: decimalString,

  // --- owed to us (point-in-time, not period-scoped) ---
  outstandingBase: decimalString,
  overdueBase: decimalString,
  contractedBase: decimalString,
  /** Delivered milestones that are not yet fully paid. */
  awaitingPaymentBase: decimalString,

  // --- breakdowns ---
  byStatus: z.object({
    NOT_PAID: z.number().int().nonnegative(),
    PARTIAL: z.number().int().nonnegative(),
    PAID: z.number().int().nonnegative(),
  }),
  bySource: z.array(
    z.object({
      paymentSourceId: cuid.nullable(),
      name: z.string(),
      kind: z.string(),
      amountBase: decimalString,
      count: z.number().int().nonnegative(),
    }),
  ),
  byRegion: z.array(
    z.object({
      region: PaymentRegion,
      amountBase: decimalString,
      count: z.number().int().nonnegative(),
    }),
  ),
  /** Per-currency truth, so a reader can sanity-check the FX conversion. */
  byCurrency: z.array(
    z.object({
      currency: ISO_CURRENCY,
      amount: decimalString,
      amountBase: decimalString,
    }),
  ),
  byExpenseCategory: z.array(
    z.object({ category: ExpenseCategory, amountBase: decimalString }),
  ),
  /** Trailing 12 months, oldest first. `YYYY-MM`. */
  monthly: z.array(
    z.object({
      month: z.string(),
      receivedBase: decimalString,
      spentBase: decimalString,
    }),
  ),
  topClients: z.array(
    z.object({ clientId: cuid, name: z.string(), amountBase: decimalString }),
  ),
  /** Exact per-currency outstanding, with no FX applied at all. */
  outstandingByCurrency: z.array(
    z.object({ currency: ISO_CURRENCY, amount: decimalString }),
  ),
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

/* --------------------------------------------------------------------------
 * Picker payloads.
 *
 * Thin name/id payloads for the finance form pickers. (They predate FINANCE
 * joining `hasFullSalesAccess` on 2026-10-06, when /clients was empty for a
 * finance manager; they stay because they are smaller than the full lists.)
 * ----------------------------------------------------------------------- */

export const financeProjectPickSchema = z.object({
  id: cuid,
  name: z.string(),
  key: z.string(),
  /** Auto-fills the client field when a project is chosen. */
  clientId: cuid.nullable(),
  clientName: z.string().nullable(),
});
export type FinanceProjectPick = z.infer<typeof financeProjectPickSchema>;

export const financeClientPickSchema = z.object({
  id: cuid,
  name: z.string(),
  /** Billing address for invoice emails. */
  email: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
});
export type FinanceClientPick = z.infer<typeof financeClientPickSchema>;

export const financeSprintPickSchema = z.object({
  id: cuid,
  name: z.string(),
  status: z.string(),
});
export type FinanceSprintPick = z.infer<typeof financeSprintPickSchema>;

export const financeTaskPickSchema = z.object({
  id: cuid,
  title: z.string(),
  status: z.string(),
});
export type FinanceTaskPick = z.infer<typeof financeTaskPickSchema>;
