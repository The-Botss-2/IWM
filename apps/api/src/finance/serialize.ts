import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@botss/database';

import type { UserScope } from '../common/decorators/user-scope.decorator';

export const D = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

/**
 * Prisma.Decimal -> the 2dp numeric string every money field uses on the wire.
 *
 * Rounding is ROUND_HALF_UP, which is what a finance manager reconciling
 * against a bank statement expects. Prisma's default is ROUND_HALF_EVEN
 * (banker's rounding), which would make 0.125 -> 0.12 and quietly disagree
 * with the statement.
 */
export function money(value: Decimal | number | string | null | undefined): string {
  if (value == null) return '0.00';
  return new D(value).toFixed(2, D.ROUND_HALF_UP);
}

/**
 * FX rates carry 8dp, matching `Decimal(18, 8)` in the schema. Rounding a rate
 * to 2dp would move real money: JPY/USD is 0.0064.
 */
export function rate(value: Decimal | number | string | null | undefined): string {
  if (value == null) return '1';
  return new D(value).toFixed(8, D.ROUND_HALF_UP);
}

/** Round a computed Decimal to 2dp for storage. */
export function round2(value: Decimal): Decimal {
  return new D(value.toFixed(2, D.ROUND_HALF_UP));
}

/**
 * Parse client-supplied money. Accepts the string-or-number union the create
 * schemas allow, and rejects NaN / Infinity rather than storing a poisoned
 * Decimal.
 */
export function toDecimal(value: string | number | null | undefined, fallback = 0): Decimal {
  if (value == null || value === '') return new D(fallback);
  try {
    const d = new D(value);
    if (!d.isFinite()) return new D(fallback);
    return d;
  } catch {
    return new D(fallback);
  }
}

/**
 * The active workspace, or a 403. Finance rows are workspace-scoped even
 * though the finance ROLE is org-level: a contract belongs to the workspace
 * its project lives in.
 */
export function requireWorkspace(scope: UserScope): string {
  if (!scope.currentWorkspaceId) {
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'Active workspace required.',
      code: 'workspace_required',
    });
  }
  return scope.currentWorkspaceId;
}

/**
 * Payment is deliberately NOT in SOFT_DELETE_MODELS - a voided payment stays
 * visible so the audit trail survives. The cost is that `voidedAt: null` has
 * to be written by hand in every aggregate; spread this so it can never be
 * forgotten silently.
 */
export const LIVE_PAYMENT = { voidedAt: null } as const;

/** A non-base amount without a rate to base: `baseAmount` would be wrong. */
export function fxRateRequired(
  baseCurrency: string,
  currency: string,
  what: 'payment' | 'expense' | 'contract',
): BadRequestException {
  return new BadRequestException({
    title: 'Exchange rate required',
    status: 400,
    detail: `Enter the exchange rate to ${baseCurrency} for a ${currency} ${what}.`,
    code: 'fx_rate_required',
  });
}

/**
 * Whether an incoming FX rate was actually given. The Zod layer already
 * refuses '' and non-positive rates; this keeps a blank from ever reading as
 * "use the default of 1" should a caller bypass it.
 */
export function hasRate(value: string | number | null | undefined): value is string | number {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/** The largest rate Decimal(18, 8) can store. */
const MAX_RATE = '9999999999.99999999';

/**
 * An incoming rate as it will be stored: rounded to the column's 8 decimals
 * BEFORE anything is computed from it (so a base amount always matches the
 * stored rate), positive, and within Decimal(18, 8). Same rule as payroll's
 * fxRateFor.
 */
export function bookRate(value: string | number): Decimal {
  const text = typeof value === 'string' ? value.trim() : value;
  const rounded = new D(toDecimal(text, 0).toFixed(8, D.ROUND_HALF_UP));
  if (rounded.lte(0) || rounded.gt(MAX_RATE)) {
    throw new BadRequestException({
      title: 'Invalid exchange rate',
      status: 400,
      detail: rounded.lte(0)
        ? 'The exchange rate must be greater than zero.'
        : 'The exchange rate is too large.',
      code: 'invalid_fx_rate',
    });
  }
  return rounded;
}
