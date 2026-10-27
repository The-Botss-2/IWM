import {
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  Eye,
  PlayCircle,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { TaskPriority, TaskStatus } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';

const STATUS_META: Record<
  TaskStatus,
  { label: string; icon: ComponentType<{ className?: string }>; tone: Parameters<typeof Badge>[0]['tone'] }
> = {
  BACKLOG: { label: 'Backlog', icon: CircleDashed, tone: 'neutral' },
  TODO: { label: 'To do', icon: Circle, tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', icon: PlayCircle, tone: 'info' },
  IN_REVIEW: { label: 'In review', icon: Eye, tone: 'warning' },
  DONE: { label: 'Done', icon: CheckCircle2, tone: 'success' },
  CANCELLED: { label: 'Cancelled', icon: CircleSlash, tone: 'danger' },
};

const PRIORITY_META: Record<
  TaskPriority,
  { label: string; icon: ComponentType<{ className?: string }>; tone: Parameters<typeof Badge>[0]['tone'] }
> = {
  LOW: { label: 'Low', icon: ArrowDown, tone: 'neutral' },
  MEDIUM: { label: 'Medium', icon: ArrowRight, tone: 'info' },
  HIGH: { label: 'High', icon: AlertTriangle, tone: 'warning' },
  URGENT: { label: 'Urgent', icon: AlertOctagon, tone: 'danger' },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} aria-label={`Status: ${meta.label}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const meta = PRIORITY_META[priority];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} aria-label={`Priority: ${meta.label}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {meta.label}
    </Badge>
  );
}

export const STATUS_OPTIONS: readonly TaskStatus[] = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
];

export const PRIORITY_OPTIONS: readonly TaskPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

export const statusLabel = (s: TaskStatus) => STATUS_META[s].label;
export const priorityLabel = (p: TaskPriority) => PRIORITY_META[p].label;
