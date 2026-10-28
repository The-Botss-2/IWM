/**
 * Money formatting and parsing, shared by Leads, Clients and Financials.
 *
 * Amounts cross the wire as 2dp numeric STRINGS (see the `decimalString`
 * schema in `@botss/shared-types`), never as floats or minor-unit integers,
 * so every helper here accepts a string as its primary input and only
 * converts to `number` at the last moment for `Intl.NumberFormat`.
 */

/** Currencies the workspace can quote and get paid in. ISO 4217. */
export const CURRENCY_OPTIONS: readonly string[] = [
  'USD',
  'EUR',
  'GBP',
  'AED',
  'PKR',
  'TRY',
  'CAD',
  'AUD',
  'INR',
];

export interface FormatCurrencyOptions {
  /**
   * Drop the decimals. Used by the CRM surfaces (leads pipeline, lead list)
   * where a deal is an estimate and cents are noise.
   *
   * Financials never passes this: a payment record has to reconcile against a
   * bank statement to the cent.
   */
  compact?: boolean;
}

/**
 * Format a Decimal-string amount with a currency code.
 *
 * Falls back to a plain locale-formatted number if `Intl` rejects the code, so
 * a typo in a currency field doesn't break the whole row render.
 */
export function formatCurrency(
  amount: string | number | null | undefined,
  currency: string,
  options: FormatCurrencyOptions = {},
): string {
  if (amount == null || amount === '') return '-';
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '-';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      ...(options.compact
        ? { maximumFractionDigits: 0 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

/**
 * Normalise free-typed money input to a 2dp decimal string the API will
 * accept, or `null` when the field is empty or unparseable.
 *
 * Strips grouping separators, currency symbols and whitespace, so pasting
 * "PKR 1,250.50" or "$1 250.5" from a bank statement works.
 */
export function parseMoneyInput(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  // Keep digits, a leading sign, and the decimal point. Everything else -
  // thousands separators, symbols, non-breaking spaces - is noise.
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n.toFixed(2);
}
