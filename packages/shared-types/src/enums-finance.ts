import { z } from 'zod';

/* eslint-disable @typescript-eslint/no-redeclare -- value/type pairs share names */

/**
 * How a contract is billed. `RETAINER` exists in the enum from day one because
 * adding a Postgres enum value later is the expensive migration; until the
 * recurring-milestone generator ships it behaves exactly like `MILESTONE`.
 */
export const BillingModel = z.enum(['ONE_TIME', 'MILESTONE', 'RETAINER']);
export type BillingModel = z.infer<typeof BillingModel>;

export const ContractStatus = z.enum([
  'DRAFT',
  'ACTIVE',
  'COMPLETED',
  'CANCELLED',
]);
export type ContractStatus = z.infer<typeof ContractStatus>;

/**
 * Derived money state, cached on Contract and ContractMilestone so it can be
 * indexed and filtered. Never set by a client - the server recomputes it.
 */
export const PaymentStatus = z.enum(['NOT_PAID', 'PARTIAL', 'PAID']);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/**
 * DELIVERY state only, deliberately separate from `paymentStatus`. Collapsing
 * the two would mean that once a milestone is part-paid you could no longer
 * tell whether the work shipped - which is exactly the "delivered, awaiting
 * payment" question the Financials tab exists to answer.
 */
export const MilestoneStatus = z.enum([
  'PENDING',
  'IN_PROGRESS',
  'DELIVERED',
  'CANCELLED',
]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

/**
 * A transaction is local or international, never both. "Both" is a property of
 * the rail, so it lives on `PaymentSource.defaultRegion` as a nullable meaning
 * "ask every time".
 */
export const PaymentRegion = z.enum(['LOCAL', 'INTERNATIONAL']);
export type PaymentRegion = z.infer<typeof PaymentRegion>;

export const PaymentSourceKind = z.enum([
  'FREELANCE_PLATFORM',
  'BANK',
  'REMITTANCE',
  'WALLET',
  'GATEWAY',
  'CASH',
  'OTHER',
]);
export type PaymentSourceKind = z.infer<typeof PaymentSourceKind>;

export const ExpenseCategory = z.enum([
  'SALARY',
  'CONTRACTOR',
  'SUBSCRIPTION',
  'PLATFORM_FEE',
  'HARDWARE',
  'SOFTWARE',
  'MARKETING',
  'TAX',
  'OFFICE',
  'OTHER',
]);
export type ExpenseCategory = z.infer<typeof ExpenseCategory>;
