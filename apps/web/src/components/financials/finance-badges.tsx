'use client';

import type {
  BillingModel,
  ContractStatus,
  ExpenseCategory,
  MilestoneStatus,
  PaymentRegion,
  PaymentStatus,
} from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand' | 'outline';

/**
 * Payment status is the column the finance manager scans for, so the three
 * states have to be distinguishable at a glance and in the same order every
 * time: nothing owed is green, part-paid is amber, unpaid is red.
 */
const PAYMENT_META: Record<PaymentStatus, { label: string; tone: Tone }> = {
  NOT_PAID: { label: 'Not paid', tone: 'danger' },
  PARTIAL: { label: 'Partial', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
};

const CONTRACT_META: Record<ContractStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** Delivery, not money. Kept visually distinct from the payment pill. */
const MILESTONE_META: Record<MilestoneStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  DELIVERED: { label: 'Delivered', tone: 'brand' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const BILLING_LABEL: Record<BillingModel, string> = {
  ONE_TIME: 'One-time',
  MILESTONE: 'Milestones',
  RETAINER: 'Retainer',
};

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  SALARY: 'Salary',
  CONTRACTOR: 'Contractor',
  SUBSCRIPTION: 'Subscription',
  PLATFORM_FEE: 'Platform fee',
  HARDWARE: 'Hardware',
  SOFTWARE: 'Software',
  MARKETING: 'Marketing',
  TAX: 'Tax',
  OFFICE: 'Office',
  OTHER: 'Other',
};

export const PAYMENT_STATUS_OPTIONS = Object.keys(PAYMENT_META) as PaymentStatus[];
export const CONTRACT_STATUS_OPTIONS = Object.keys(CONTRACT_META) as ContractStatus[];
export const MILESTONE_STATUS_OPTIONS = Object.keys(MILESTONE_META) as MilestoneStatus[];
export const BILLING_MODEL_OPTIONS = Object.keys(BILLING_LABEL) as BillingModel[];
export const EXPENSE_CATEGORY_OPTIONS = Object.keys(CATEGORY_LABEL) as ExpenseCategory[];

export const paymentStatusLabel = (s: PaymentStatus) => PAYMENT_META[s].label;
export const contractStatusLabel = (s: ContractStatus) => CONTRACT_META[s].label;
export const milestoneStatusLabel = (s: MilestoneStatus) => MILESTONE_META[s].label;
export const billingModelLabel = (m: BillingModel) => BILLING_LABEL[m];

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const meta = PAYMENT_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const meta = CONTRACT_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function MilestoneStatusBadge({ status }: { status: MilestoneStatus }) {
  const meta = MILESTONE_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/**
 * Local vs international is one of the four questions the tab exists to
 * answer, so it gets a pill rather than being buried in a column.
 */
export function RegionBadge({ region }: { region: PaymentRegion }) {
  return (
    <Badge tone={region === 'LOCAL' ? 'neutral' : 'info'}>
      {region === 'LOCAL' ? 'Local' : 'International'}
    </Badge>
  );
}
