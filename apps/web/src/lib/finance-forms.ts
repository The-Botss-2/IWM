import {
  type ContractMilestone,
  type ExpenseCategory,
  type ExpenseWithRefs,
  isRateText,
  type MilestoneStatus,
  type PaymentRegion,
  type PaymentWithSource,
  type UpdateExpenseInput,
  type UpdateMilestoneInput,
  type UpdatePaymentInput,
} from '@botss/shared-types';

/**
 * Edit forms send only what changed: a PATCH that repeats unchanged money
 * fields would still be a write the server recalculates and audits. These
 * diff the form against the stored row.
 */

/** Two decimal strings (or typed text) holding the same amount. */
function sameAmount(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean {
  const x = Number(a ?? 0);
  const y = Number(b ?? 0);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a) === String(b);
}

function sameDate(a: Date | string | null | undefined, b: Date | null | undefined): boolean {
  const x = a ? new Date(a).getTime() : null;
  const y = b ? b.getTime() : null;
  return x === y;
}

/** Trimmed text, with an empty field meaning "clear it". */
function textOrNull(value: string): string | null {
  const t = value.trim();
  return t ? t : null;
}

export interface MilestoneForm {
  title: string;
  amount: string;
  dueDate: Date | null;
  description: string;
  status: MilestoneStatus;
}

export function milestoneFormFrom(m: ContractMilestone): MilestoneForm {
  return {
    title: m.title,
    amount: m.amount,
    dueDate: m.dueDate ? new Date(m.dueDate) : null,
    description: m.description ?? '',
    status: m.status,
  };
}

export function milestoneChanges(m: ContractMilestone, form: MilestoneForm): UpdateMilestoneInput {
  const out: UpdateMilestoneInput = {};
  if (form.title.trim() !== m.title) out.title = form.title.trim();
  if (!sameAmount(form.amount || '0', m.amount)) out.amount = form.amount || '0';
  // Clearing the date sends null; the server stores "no due date".
  if (!sameDate(m.dueDate, form.dueDate)) out.dueDate = form.dueDate;
  const description = textOrNull(form.description);
  if (description !== (m.description ?? null)) out.description = description;
  if (form.status !== m.status) out.status = form.status;
  return out;
}

export interface PaymentForm {
  amount: string;
  receivedAmount: string;
  receivedCurrency: string;
  feeAmount: string;
  fxRate: string;
  milestoneId: string | null;
  paymentSourceId: string | null;
  region: PaymentRegion;
  reference: string;
  paidAt: Date | null;
  notes: string;
}

export function paymentFormFrom(p: PaymentWithSource): PaymentForm {
  return {
    amount: p.amount,
    receivedAmount: p.receivedAmount,
    receivedCurrency: p.receivedCurrency,
    feeAmount: p.feeAmount,
    fxRate: p.fxRate,
    milestoneId: p.milestoneId,
    paymentSourceId: p.paymentSourceId,
    region: p.region,
    reference: p.reference ?? '',
    paidAt: new Date(p.paidAt),
    notes: p.notes ?? '',
  };
}

/**
 * A payment that landed exactly as billed (same currency, same amount, no
 * fee). Editing its amount should move the received amount with it, or the
 * server keeps the old received figure and revenue silently disagrees.
 */
export function landedAsBilled(p: PaymentWithSource): boolean {
  return (
    p.receivedCurrency === p.currency &&
    sameAmount(p.receivedAmount, p.amount) &&
    sameAmount(p.feeAmount, 0)
  );
}

export function paymentChanges(
  p: PaymentWithSource,
  form: PaymentForm,
  baseCurrency: string,
): UpdatePaymentInput {
  const out: UpdatePaymentInput = {};
  if (!sameAmount(form.amount || '0', p.amount)) out.amount = form.amount || '0';
  if (!sameAmount(form.receivedAmount || '0', p.receivedAmount)) {
    out.receivedAmount = form.receivedAmount || '0';
  }
  if (form.receivedCurrency !== p.receivedCurrency) out.receivedCurrency = form.receivedCurrency;
  if (!sameAmount(form.feeAmount || '0', p.feeAmount)) out.feeAmount = form.feeAmount || '0';
  // The server forces 1 for the base currency and otherwise keeps the stored
  // rate, so a rate is sent only when it was edited or the currency moved.
  if (
    form.receivedCurrency !== baseCurrency &&
    (out.receivedCurrency !== undefined || !sameAmount(form.fxRate, p.fxRate))
  ) {
    out.fxRate = form.fxRate;
  }
  if (form.milestoneId !== p.milestoneId) out.milestoneId = form.milestoneId;
  if (form.paymentSourceId !== p.paymentSourceId) out.paymentSourceId = form.paymentSourceId;
  if (form.region !== p.region) out.region = form.region;
  const reference = textOrNull(form.reference);
  if (reference !== (p.reference ?? null)) out.reference = reference;
  if (form.paidAt && !sameDate(p.paidAt, form.paidAt)) out.paidAt = form.paidAt;
  const notes = textOrNull(form.notes);
  if (notes !== (p.notes ?? null)) out.notes = notes;
  return out;
}

export interface ExpenseForm {
  description: string;
  vendor: string;
  category: ExpenseCategory;
  projectId: string | null;
  amount: string;
  currency: string;
  fxRate: string;
  paymentSourceId: string | null;
  incurredAt: Date | null;
}

export function expenseFormFrom(e: ExpenseWithRefs): ExpenseForm {
  return {
    description: e.description,
    vendor: e.vendor ?? '',
    category: e.category,
    projectId: e.projectId,
    amount: e.amount,
    currency: e.currency,
    fxRate: e.fxRate,
    paymentSourceId: e.paymentSourceId,
    incurredAt: new Date(e.incurredAt),
  };
}

export function expenseChanges(
  e: ExpenseWithRefs,
  form: ExpenseForm,
  baseCurrency: string,
): UpdateExpenseInput {
  const out: UpdateExpenseInput = {};
  if (form.description.trim() !== e.description) out.description = form.description.trim();
  const vendor = textOrNull(form.vendor);
  if (vendor !== (e.vendor ?? null)) out.vendor = vendor;
  if (form.category !== e.category) out.category = form.category;
  if (form.projectId !== e.projectId) out.projectId = form.projectId;
  if (!sameAmount(form.amount || '0', e.amount)) out.amount = form.amount || '0';
  if (form.currency !== e.currency) out.currency = form.currency;
  // Same rule as payments: never resend an untouched rate (the server keeps
  // the stored one, and forces 1 for the base currency itself).
  if (
    form.currency !== baseCurrency &&
    (out.currency !== undefined || !sameAmount(form.fxRate, e.fxRate))
  ) {
    out.fxRate = form.fxRate;
  }
  if (form.paymentSourceId !== e.paymentSourceId) out.paymentSourceId = form.paymentSourceId;
  if (form.incurredAt && !sameDate(e.incurredAt, form.incurredAt)) out.incurredAt = form.incurredAt;
  return out;
}

/**
 * Why the exchange rate cannot be saved, or null. A foreign currency needs a
 * positive rate, and an amount moved to a different currency must not keep
 * the old currency's stored rate (moving off the base currency would keep 1
 * and book the foreign amount as base money).
 */
export function fxRateProblem(opts: {
  currency: string;
  /** The currency stored before this edit (the base currency for a new row). */
  previousCurrency: string;
  /** The rate stored with `previousCurrency` (1 for the base currency). */
  previousRate: string;
  fxRate: string;
  baseCurrency: string;
}): string | null {
  const { currency, previousCurrency, previousRate, fxRate, baseCurrency } = opts;
  if (currency === baseCurrency) return null;
  // The API's own check: plain positive decimal text within Decimal(18, 8).
  if (!isRateText(fxRate)) {
    return `Enter the rate from ${currency} to ${baseCurrency} as a number, like 278.50.`;
  }
  const oldRate = previousCurrency === baseCurrency ? '1' : previousRate;
  if (currency !== previousCurrency && sameAmount(fxRate, oldRate)) {
    return `Enter the rate from ${currency} to ${baseCurrency} - the ${previousCurrency} rate doesn't apply.`;
  }
  return null;
}

/**
 * The rate field after the currency changes: 1 for the base currency, the
 * stored rate when switching back to the stored currency, otherwise blank so
 * the new currency's rate has to be entered.
 */
export function rateAfterCurrencyChange(opts: {
  previousCurrency: string;
  nextCurrency: string;
  currentRate: string;
  baseCurrency: string;
  /** The currency and rate stored before this edit, restored on switching back. */
  stored?: { currency: string; rate: string };
}): string {
  const { previousCurrency, nextCurrency, currentRate, baseCurrency, stored } = opts;
  if (nextCurrency === baseCurrency) return '1';
  if (nextCurrency === previousCurrency) return currentRate;
  if (stored && nextCurrency === stored.currency) return stored.rate;
  return '';
}
