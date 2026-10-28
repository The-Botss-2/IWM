/**
 * Invoice arithmetic for live totals in the editor.
 *
 * Mirrors InvoicesService.computeLineItem on the API (which stays the
 * authority and uses Prisma.Decimal): per line, gross = quantity x unit price,
 * discount = gross x discount%, tax = (gross - discount) x tax%, amount =
 * gross - discount + tax. Works in integer thousandths of a minor unit so
 * summing many lines never drifts the way floating point does, then rounds
 * half away from zero to cents once, at the end.
 */

export interface InvoiceMathLine {
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  taxRate?: string | number | null;
  discountRate?: string | number | null;
}

export interface InvoiceMathTotals {
  subtotal: string;
  discount: string;
  tax: string;
  total: string;
  lines: string[];
}

const SCALE = 100_000n; // 1.00000 in fixed point

function toFixedPoint(value: string | number | null | undefined, fallback: string): bigint {
  const raw =
    value === null || value === undefined || value === '' ? fallback : String(value).trim();
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) return toFixedPoint(fallback, fallback);
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] || '0');
  const frac = (match[3] ?? '').padEnd(5, '0').slice(0, 5);
  return sign * (whole * SCALE + BigInt(frac || '0'));
}

function mulFixed(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

function toMoneyString(fixed: bigint): string {
  // Round half away from zero to 2 decimals.
  const negative = fixed < 0n;
  const abs = negative ? -fixed : fixed;
  const cents = (abs + 500n) / 1_000n;
  const str = `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  return negative && cents !== 0n ? `-${str}` : str;
}

export function computeInvoiceTotals(lines: InvoiceMathLine[]): InvoiceMathTotals {
  let subtotal = 0n;
  let discount = 0n;
  let tax = 0n;
  const amounts: string[] = [];
  for (const line of lines) {
    const quantity = toFixedPoint(line.quantity, '1');
    const unitPrice = toFixedPoint(line.unitPrice, '0');
    const taxRate = toFixedPoint(line.taxRate, '0');
    const discountRate = toFixedPoint(line.discountRate, '0');
    const gross = mulFixed(quantity, unitPrice);
    const lineDiscount = mulFixed(gross, discountRate) / 100n;
    const taxable = gross - lineDiscount;
    const lineTax = mulFixed(taxable, taxRate) / 100n;
    subtotal += gross;
    discount += lineDiscount;
    tax += lineTax;
    amounts.push(toMoneyString(taxable + lineTax));
  }
  return {
    subtotal: toMoneyString(subtotal),
    discount: toMoneyString(discount),
    tax: toMoneyString(tax),
    total: toMoneyString(subtotal - discount + tax),
    lines: amounts,
  };
}
