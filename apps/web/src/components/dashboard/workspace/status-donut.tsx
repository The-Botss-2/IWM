'use client';

import { PieChart as PieIcon } from 'lucide-react';
import { useMemo } from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { TaskStatus } from '@botss/shared-types';

import {
  CATEGORICAL_PALETTE,
  CHART_COLORS,
} from '@/components/dashboard/workspace/colors';
import { WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useTaskStatusCounts } from '@/hooks/use-workspace-task-stats';

const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  IN_REVIEW: 'In review',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

const STATUS_COLOR: Record<TaskStatus, string> = {
  BACKLOG: CHART_COLORS.muted,
  TODO: CATEGORICAL_PALETTE[0],
  IN_PROGRESS: CATEGORICAL_PALETTE[1],
  IN_REVIEW: CATEGORICAL_PALETTE[2],
  DONE: CHART_COLORS.teal,
  CANCELLED: CHART_COLORS.line,
};

export function StatusDonutWidget() {
  const q = useTaskStatusCounts();
  const total = q.data?.total ?? 0;
  const data = useMemo(
    () =>
      (q.data?.rows ?? []).map((r) => ({
        ...r,
        label: STATUS_LABEL[r.status],
        color: STATUS_COLOR[r.status],
      })),
    [q.data],
  );

  return (
    <WidgetShell id="widget-ws-status" title="Tasks by status" icon={PieIcon}>
      {q.isLoading ? (
        <Skeleton className="h-44 w-full" />
      ) : q.isError && !q.data ? (
        <QueryError compact message="Couldn't load task statuses." onRetry={() => void q.refetch()} />
      ) : data.length === 0 ? (
        <div className="grid h-44 place-items-center text-xs text-ink-muted">
          No tasks yet.
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <div className="relative h-40 w-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={48}
                  outerRadius={72}
                  paddingAngle={2}
                  startAngle={90}
                  endAngle={-270}
                  stroke="white"
                  strokeWidth={2}
                >
                  {data.map((d) => (
                    <Cell key={d.status} fill={d.color} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: 'white',
                    border: `1px solid ${CHART_COLORS.line}`,
                    borderRadius: 8,
                    fontSize: 12,
                    boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
                  }}
                  formatter={(v, _n, item) => {
                    const n = typeof v === 'number' ? v : Number(v);
                    const label = (item.payload as { label?: string } | undefined)?.label ?? '';
                    return [
                      `${n} (${total ? Math.round((n / total) * 100) : 0}%)`,
                      label,
                    ];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="text-2xl font-bold text-ink">{total}</div>
                <div className="text-[10px] uppercase tracking-wide text-ink-muted">
                  tasks
                </div>
              </div>
            </div>
          </div>
          <ul className="flex-1 space-y-1.5" role="list">
            {data.map((d) => (
              <li
                key={d.status}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="inline-flex items-center gap-1.5 text-ink">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.label}
                </span>
                <span className="font-medium text-ink">{d.value}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </WidgetShell>
  );
}
