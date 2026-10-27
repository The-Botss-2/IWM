import type {
  BillingModel,
  ContractStatus,
  InvoiceStatus,
  MilestoneStatus,
  PaymentStatus,
  ProjectStatus,
  TaskStatus,
} from '@botss/shared-types';

import { Badge, type BadgeProps } from '@/components/ui/badge';

type Tone = NonNullable<BadgeProps['tone']>;

interface StatusMeta {
  label: string;
  tone: Tone;
}

/*
 * Client-facing status copy. Deliberately separate from the staff badges in
 * components/tasks and components/financials: a client reads "Not started"
 * where staff read "Backlog", and a milestone that is not paid yet is not an
 * alarm in red. The portal never shows drafts or archived work; those keys
 * exist only because the enums carry them.
 */

const PROJECT_META: Record<ProjectStatus, StatusMeta> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'info' },
  ON_HOLD: { label: 'On hold', tone: 'warning' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  ARCHIVED: { label: 'Archived', tone: 'neutral' },
};

/** Backlog and to-do both read "Not started", matching the progress counts. */
const TASK_META: Record<TaskStatus, StatusMeta> = {
  BACKLOG: { label: 'Not started', tone: 'neutral' },
  TODO: { label: 'Not started', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  IN_REVIEW: { label: 'In review', tone: 'outline' },
  DONE: { label: 'Done', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const MILESTONE_META: Record<MilestoneStatus, StatusMeta> = {
  PENDING: { label: 'Not started', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'info' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const PAYMENT_META: Record<PaymentStatus, StatusMeta> = {
  NOT_PAID: { label: 'Unpaid', tone: 'neutral' },
  PARTIAL: { label: 'Part paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
};

const INVOICE_META: Record<InvoiceStatus, StatusMeta> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SENT: { label: 'Open', tone: 'info' },
  PARTIALLY_PAID: { label: 'Part paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
  OVERDUE: { label: 'Overdue', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  REFUNDED: { label: 'Refunded', tone: 'neutral' },
};

const CONTRACT_META: Record<ContractStatus, StatusMeta> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  ACTIVE: { label: 'Active', tone: 'info' },
  COMPLETED: { label: 'Completed', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const BILLING_MODEL_LABEL: Record<BillingModel, string> = {
  ONE_TIME: 'One-time',
  MILESTONE: 'Milestones',
  RETAINER: 'Retainer',
};

export const billingModelLabel = (model: BillingModel): string => BILLING_MODEL_LABEL[model];

/**
 * `srPrefix` names the badge for screen readers where two of them sit side
 * by side (delivery next to payment), so "Delivered, Unpaid" is not a riddle.
 */
function StatusBadge({ meta, srPrefix }: { meta: StatusMeta; srPrefix?: string }) {
  return (
    <Badge tone={meta.tone} className="shrink-0 whitespace-nowrap">
      {srPrefix ? <span className="sr-only">{srPrefix}: </span> : null}
      {meta.label}
    </Badge>
  );
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <StatusBadge meta={PROJECT_META[status]} />;
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <StatusBadge meta={TASK_META[status]} />;
}

export function MilestoneStatusBadge({ status }: { status: MilestoneStatus }) {
  return <StatusBadge meta={MILESTONE_META[status]} srPrefix="Delivery" />;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  return <StatusBadge meta={PAYMENT_META[status]} srPrefix="Payment" />;
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return <StatusBadge meta={INVOICE_META[status]} />;
}

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  return <StatusBadge meta={CONTRACT_META[status]} />;
}
