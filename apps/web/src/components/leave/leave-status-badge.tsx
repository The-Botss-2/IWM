import type { LeaveStatus } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { LEAVE_STATUS_LABELS } from '@/lib/leave';

const TONE: Record<LeaveStatus, 'warning' | 'success' | 'danger'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
};

export function LeaveStatusBadge({ status }: { status: LeaveStatus }) {
  return <Badge tone={TONE[status]}>{LEAVE_STATUS_LABELS[status]}</Badge>;
}
