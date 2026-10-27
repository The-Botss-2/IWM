import { z } from 'zod';

/**
 * Decimal money / quantity value. The wire format is ALWAYS a numeric string
 * with at most 2 decimal places, so JavaScript never loses precision on cents.
 * Services are the only place that convert to/from `Prisma.Decimal`; clients
 * treat these as opaque strings and hand them straight back.
 */
export const decimalString = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

/**
 * FX rate. Wider than `decimalString` because a rate needs far more precision
 * than a money amount: PKR/USD sits around 278.50 but JPY/USD is 0.0064, and
 * rounding either to 2dp would move real money. Mirrors `Decimal(18, 8)` in
 * the Prisma schema.
 */
export const rateString = z.string().regex(/^\d+(\.\d{1,8})?$/);

/** Plain decimal text: "278.5", ".5", "1." - never exponent notation. */
const RATE_TEXT = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * Rates are stored as Decimal(18, 8): at most 10 digits before the point.
 * Larger values would overflow the column (a 500), so they are refused here.
 */
const MAX_RATE_INTEGER_DIGITS = 10;

function rateTextProblem(text: string): string | null {
  const t = text.trim();
  if (!RATE_TEXT.test(t)) return 'Enter the exchange rate as a number, like 278.50.';
  if (!(Number(t) > 0)) return 'The exchange rate must be greater than zero.';
  const integerDigits = (t.split('.')[0] ?? '').replace(/^0+/, '').length;
  if (integerDigits > MAX_RATE_INTEGER_DIGITS) return 'The exchange rate is too large.';
  return null;
}

/**
 * Whether typed text is an exchange rate the API accepts: a plain positive
 * decimal ("278.5", ".5", "1.") with at most 10 digits before the point. The
 * one check shared by the request schemas and the web forms.
 */
export function isRateText(text: string): boolean {
  return rateTextProblem(text) === null;
}

/**
 * FX rate as accepted on the way IN (contracts, payments, expenses, invoice
 * payments). Positive, finite, within Decimal(18, 8); the services round it
 * to 8 decimals before using it. Omit the field to keep a stored rate or use
 * a default.
 */
export const rateInput = z.union([
  z
    .string()
    .trim()
    .superRefine((v, ctx) => {
      const problem = rateTextProblem(v);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
  z
    .number()
    .finite()
    .positive('The exchange rate must be greater than zero.')
    .lt(10 ** MAX_RATE_INTEGER_DIGITS, 'The exchange rate is too large.'),
]);

/** ISO 4217 currency code. */
export const ISO_CURRENCY = z.string().regex(/^[A-Z]{3}$/);

/**
 * Money as accepted on the way IN. Forms hand over whatever the user typed and
 * the service normalises; responses always come back as `decimalString`.
 */
export const moneyInput = z.union([z.string(), z.number()]);
export type MoneyInput = z.infer<typeof moneyInput>;
