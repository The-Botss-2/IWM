import type { PayrollPaymentMethod } from '@botss/shared-types';

import { parseMoneyInput } from './money';

/** Payroll is paid in PKR. */
export const PAYROLL_CURRENCY = 'PKR';

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "September 2026". */
export function payrollPeriod(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? ''} ${year}`.trim();
}

/** The years offered when starting a run: last year, this year, next year. */
export function payrollYearOptions(now = new Date()): number[] {
  const y = now.getFullYear();
  return [y - 1, y, y + 1];
}

export const PAYMENT_METHOD_LABELS: Record<PayrollPaymentMethod, string> = {
  BANK_TRANSFER: 'Bank transfer',
  CASH: 'Cash',
  CHEQUE: 'Cheque',
};

/**
 * Net pay as the form shows it while typing: salary + bonus + commission -
 * deduction - tax. The server recomputes it on save; this is only the
 * preview. Returns null when an amount is unreadable.
 */
export function previewNet(amounts: {
  salary: string;
  bonus: string;
  commission: string;
  deduction: string;
  tax: string;
}): number | null {
  const { salary, bonus, commission, deduction, tax } = amounts;
  const parts = [salary, bonus, commission, deduction, tax].map((v) =>
    v.trim() === '' ? '0.00' : parseMoneyInput(v),
  );
  if (parts.some((p) => p === null)) return null;
  // In cents, so 0.1 + 0.2 style float error never shows.
  const [s, b, c, d, t] = parts.map((p) => Math.round(Number(p) * 100)) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return (s + b + c - d - t) / 100;
}

/**
 * An exchange rate as the API accepts it (`rateString`: digits, at most 8
 * decimals, a period for the decimal point). Accepts what people paste from a
 * calculator, e.g. "0.00359066427" or " 0.0036 ", and rounds to 8 decimals.
 * Null when it is not a positive number.
 *
 * Commas are rejected, never stripped: in Turkey "0,0036" means 0.0036, and
 * stripping the comma would book every salary at a rate of 36.
 */
export function normalizeRate(raw: string): string | null {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  const fixed = n.toFixed(8).replace(/\.?0+$/, '');
  if (!/^\d+(\.\d{1,8})?$/.test(fixed) || Number(fixed) <= 0) return null;
  return fixed;
}

/**
 * The pay date to store for a day picked in the date picker. The picker
 * returns local midnight, which in Pakistan (UTC+5) is the previous day in
 * UTC, and payslips print dates in UTC. Noon UTC of the picked calendar day
 * reads as that same day everywhere the team works.
 */
export function toPayDate(d: Date): Date {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12));
}

/** Sum 2dp money strings exactly (in cents), returned as a 2dp string. */
export function sumAmounts(values: string[]): string {
  const cents = values.reduce((total, v) => total + Math.round(Number(v) * 100), 0);
  return (cents / 100).toFixed(2);
}

/** A typed amount the API will accept: blank is 0; null when unreadable or negative. */
export function payrollAmount(raw: string): string | null {
  if (raw.trim() === '') return '0.00';
  const parsed = parseMoneyInput(raw);
  if (parsed === null || Number(parsed) < 0) return null;
  return parsed;
}
