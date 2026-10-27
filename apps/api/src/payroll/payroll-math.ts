import { BadRequestException } from '@nestjs/common';

import { D, type Decimal, money, round2 } from '../finance/serialize';

/** Largest value `Decimal(14, 2)` can hold. */
const MAX_AMOUNT = new D('999999999999.99');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse an amount typed into a payroll form. Unlike `toDecimal` in the
 * finance helpers, a bad value is an error here, never a silent zero: a
 * salary that quietly became 0 would be paid as 0.
 */
export function parseAmount(value: string | number | null | undefined, field: string): Decimal {
  const result = readAmount(value);
  if (typeof result === 'string') throw invalid(field, result);
  return result;
}

/**
 * `parseAmount` without the throw, for the sheet import, which collects a
 * problem per cell. Returns the amount, or what is wrong with it.
 */
export function readAmount(value: string | number | null | undefined): Decimal | string {
  if (value == null || value === '') return new D(0);
  let d: Decimal;
  try {
    d = new D(typeof value === 'string' ? value.replace(/[,\s]/g, '') : value);
  } catch {
    return 'is not a number';
  }
  if (!d.isFinite()) return 'is not a number';
  if (d.isNegative()) return 'cannot be negative';
  const rounded = round2(d);
  if (rounded.gt(MAX_AMOUNT)) return 'is too large';
  return rounded;
}

export interface LineAmounts {
  salary: Decimal;
  bonus: Decimal;
  commission: Decimal;
  deduction: Decimal;
  tax: Decimal;
}

/**
 * salary + bonus + commission - deduction - tax. Null when that is negative:
 * a line is refused, never clamped to zero.
 */
export function netOrNull(a: LineAmounts): Decimal | null {
  const net = round2(a.salary.plus(a.bonus).plus(a.commission).minus(a.deduction).minus(a.tax));
  return net.isNegative() ? null : net;
}

export const NEGATIVE_NET_DETAIL = 'Deductions and tax are larger than salary, bonus and commission.';

export function computeNet(a: LineAmounts): Decimal {
  const net = netOrNull(a);
  if (!net) {
    throw new BadRequestException({
      title: 'Deduction too large',
      status: 400,
      detail: NEGATIVE_NET_DETAIL,
      code: 'payroll_negative_net',
    });
  }
  return net;
}

export interface PayrollAmounts {
  salary: Decimal | string;
  bonus: Decimal | string;
  commission: Decimal | string;
  deduction: Decimal | string;
  tax: Decimal | string;
  net: Decimal | string;
}

/** Column totals for a run, as 2dp strings. */
export function runTotals(items: PayrollAmounts[]) {
  let salary = new D(0);
  let bonus = new D(0);
  let commission = new D(0);
  let deduction = new D(0);
  let tax = new D(0);
  let net = new D(0);
  for (const item of items) {
    salary = salary.plus(item.salary);
    bonus = bonus.plus(item.bonus);
    commission = commission.plus(item.commission);
    deduction = deduction.plus(item.deduction);
    tax = tax.plus(item.tax);
    net = net.plus(item.net);
  }
  return {
    totalSalary: money(salary),
    totalBonus: money(bonus),
    totalCommission: money(commission),
    totalDeduction: money(deduction),
    totalTax: money(tax),
    totalNet: money(net),
  };
}

/** "Sep 2026". */
export function periodLabel(year: number, month: number): string {
  return `${MONTHS[month - 1] ?? '???'} ${year}`;
}

/** "2026-09", for filenames. */
export function periodSlug(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Only the last 4 characters of an account number go on a payslip. */
export function maskAccount(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, '');
  if (compact.length <= 4) return compact;
  return `•••• ${compact.slice(-4)}`;
}

/** A filename-safe version of a person's name. */
export function nameSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'employee';
}

/**
 * Whether salary expenses inserted in one batch came back in the same order
 * as the payroll lines they were built from: same count, and each expense's
 * vendor and amount equal its line's name and net. Paying a run pairs them
 * by position, so anything else must abort rather than mislink.
 */
export function expensesMatchLines(
  expenses: ReadonlyArray<{ vendor: string | null; amount: Decimal | string }>,
  lines: ReadonlyArray<{ employeeName: string; net: Decimal | string }>,
): boolean {
  return (
    expenses.length === lines.length &&
    expenses.every((e, i) => {
      const line = lines[i]!;
      return e.vendor === line.employeeName && new D(e.amount).eq(line.net);
    })
  );
}

function invalid(field: string, problem: string): BadRequestException {
  return new BadRequestException({
    title: 'Invalid amount',
    status: 400,
    detail: `${field} ${problem}.`,
    code: 'payroll_invalid_amount',
  });
}
