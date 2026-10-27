import { z } from 'zod';

import { cuid } from './common/id.js';
import { decimalString, ISO_CURRENCY, moneyInput, rateInput, rateString } from './common/money.js';
import { paginationQuerySchema, sortOrderSchema } from './common/pagination.js';
import {
  BillingModel,
  ContractStatus,
  MilestoneStatus,
  PaymentStatus,
} from './enums-finance.js';

/**
 * A payment stage on a contract, optionally tied to the project work that
 * earns it.
 *
 * `status` is DELIVERY and `paymentStatus` is MONEY - two independent columns.
 * Delivery never moves money: `DELIVERED` is the signal that a milestone has
 * become billable, not that it has been paid.
 */
export const contractMilestoneSchema = z.object({
  id: cuid,
  contractId: cuid,
  position: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  amount: decimalString,
  /** Cached; recomputed server-side from non-voided payments. */
  amountPaid: decimalString,
  status: MilestoneStatus,
  paymentStatus: PaymentStatus,
  dueDate: z.coerce.date().nullable(),
  deliveredAt: z.coerce.date().nullable(),
  /** Optional linked sprint - completing it flips `status` to DELIVERED. */
  sprintId: cuid.nullable(),
  autoDeliver: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ContractMilestone = z.infer<typeof contractMilestoneSchema>;

/** Milestone plus the project work it bills, for the detail view. */
export const contractMilestoneWithWorkSchema = contractMilestoneSchema.extend({
  sprint: z
    .object({ id: cuid, name: z.string(), status: z.string() })
    .nullable(),
  tasks: z.array(
    z.object({ id: cuid, title: z.string(), status: z.string() }),
  ),
});
export type ContractMilestoneWithWork = z.infer<
  typeof contractMilestoneWithWorkSchema
>;

/**
 * The root money object: what we agreed to bill a client, and on what model.
 *
 * A project may hold several contracts (an initial build plus a later retainer
 * or change-order), so `projectId` is not unique.
 */
export const contractSchema = z.object({
  id: cuid,
  workspaceId: cuid,
  projectId: cuid.nullable(),
  clientId: cuid.nullable(),
  createdById: cuid,
  title: z.string().min(1).max(200),
  billingModel: BillingModel,
  status: ContractStatus,
  currency: ISO_CURRENCY,
  totalValue: decimalString,
  /** Cached. Recomputed from scratch server-side, never incremented. */
  amountPaid: decimalString,
  paymentStatus: PaymentStatus,
  /** Contract currency -> org base currency, BOOKED at creation time. */
  fxRateToBase: rateString,
  baseTotalValue: decimalString,
  startDate: z.coerce.date().nullable(),
  endDate: z.coerce.date().nullable(),
  notes: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  deletedAt: z.coerce.date().nullable(),
});
export type Contract = z.infer<typeof contractSchema>;

const partySummary = z.object({ id: cuid, name: z.string() }).nullable();

/** List row: contract plus the names needed to render it. */
export const contractListItemSchema = contractSchema.extend({
  project: partySummary,
  client: partySummary,
  milestoneCount: z.number().int().nonnegative(),
});
export type ContractListItem = z.infer<typeof contractListItemSchema>;

export const contractWithMilestonesSchema = contractSchema.extend({
  project: partySummary,
  client: partySummary,
  createdBy: z.object({ id: cuid, name: z.string() }).nullable(),
  milestones: z.array(contractMilestoneWithWorkSchema),
});
export type ContractWithMilestones = z.infer<typeof contractWithMilestonesSchema>;

/** Inline milestone, so a milestone contract is created in one round-trip. */
const createMilestoneInlineSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amount: moneyInput.optional(),
  dueDate: z.coerce.date().optional(),
});

export const createContractSchema = z
  .object({
    projectId: cuid.optional(),
    clientId: cuid.optional(),
    title: z.string().min(1).max(200),
    billingModel: BillingModel.optional(),
    status: ContractStatus.optional(),
    currency: ISO_CURRENCY.optional(),
    /** Ignored for MILESTONE contracts - the milestone sum is authoritative. */
    totalValue: moneyInput.optional(),
    fxRateToBase: rateInput.optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().optional(),
    notes: z.string().max(4000).optional(),
    milestones: z.array(createMilestoneInlineSchema).max(100).optional(),
  })
  .refine((v) => v.projectId != null || v.clientId != null, {
    message: 'A contract needs a project or a client.',
    path: ['projectId'],
  });
export type CreateContractInput = z.infer<typeof createContractSchema>;

export const updateContractSchema = z.object({
  projectId: cuid.nullable().optional(),
  clientId: cuid.nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  billingModel: BillingModel.optional(),
  status: ContractStatus.optional(),
  currency: ISO_CURRENCY.optional(),
  totalValue: moneyInput.optional(),
  fxRateToBase: rateInput.optional(),
  startDate: z.coerce.date().nullable().optional(),
  endDate: z.coerce.date().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});
export type UpdateContractInput = z.infer<typeof updateContractSchema>;

export const createMilestoneSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  amount: moneyInput.optional(),
  dueDate: z.coerce.date().optional(),
  sprintId: cuid.nullable().optional(),
  autoDeliver: z.boolean().optional(),
});
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = createMilestoneSchema.partial().extend({
  /** Delivery only. Payment status is server-derived and cannot be set. */
  status: MilestoneStatus.optional(),
  description: z.string().max(2000).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
});
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

export const reorderMilestonesSchema = z.object({
  ids: z.array(cuid).min(1).max(200),
});
export type ReorderMilestonesInput = z.infer<typeof reorderMilestonesSchema>;

/** Link a milestone to the project work that earns it. Replaces, not merges. */
export const linkMilestoneWorkSchema = z.object({
  sprintId: cuid.nullable().optional(),
  taskIds: z.array(cuid).max(200).optional(),
  autoDeliver: z.boolean().optional(),
});
export type LinkMilestoneWorkInput = z.infer<typeof linkMilestoneWorkSchema>;

export const listContractsQuerySchema = paginationQuerySchema.extend({
  status: ContractStatus.optional(),
  paymentStatus: PaymentStatus.optional(),
  billingModel: BillingModel.optional(),
  projectId: cuid.optional(),
  clientId: cuid.optional(),
  currency: ISO_CURRENCY.optional(),
  q: z.string().max(120).optional(),
  sort: z
    .enum(['createdAt', 'updatedAt', 'title', 'totalValue', 'amountPaid'])
    .default('createdAt'),
  order: sortOrderSchema,
});
export type ListContractsQuery = z.infer<typeof listContractsQuerySchema>;

/**
 * Delivered work that has not been paid for - the payoff of linking milestones
 * to sprints and tasks, and the first thing the finance manager chases.
 */
export const awaitingPaymentItemSchema = z.object({
  milestoneId: cuid,
  contractId: cuid,
  contractTitle: z.string(),
  milestoneTitle: z.string(),
  currency: ISO_CURRENCY,
  amount: decimalString,
  amountPaid: decimalString,
  paymentStatus: PaymentStatus,
  deliveredAt: z.coerce.date().nullable(),
  dueDate: z.coerce.date().nullable(),
  project: partySummary,
  client: partySummary,
});
export type AwaitingPaymentItem = z.infer<typeof awaitingPaymentItemSchema>;
