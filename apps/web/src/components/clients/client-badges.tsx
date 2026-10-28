import type { ClientStatus } from '@botss/shared-types';

import { Badge, type BadgeProps } from '@/components/ui/badge';

const STATUS_TONE: Record<ClientStatus, NonNullable<BadgeProps['tone']>> = {
  PROSPECT: 'neutral',
  ACTIVE: 'success',
  PAUSED: 'warning',
  CHURNED: 'danger',
};

const STATUS_LABEL: Record<ClientStatus, string> = {
  PROSPECT: 'Prospect',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  CHURNED: 'Churned',
};

export const CLIENT_STATUS_OPTIONS: ClientStatus[] = ['PROSPECT', 'ACTIVE', 'PAUSED', 'CHURNED'];

export function statusLabel(s: ClientStatus): string {
  return STATUS_LABEL[s];
}

export function ClientStatusBadge({ status }: { status: ClientStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}
