'use client';

import { Target } from 'lucide-react';
import { useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';

import { CATEGORICAL_PALETTE, CHART_COLORS } from '@/components/dashboard/workspace/colors';
import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useDashboardHoursWindow } from '@/hooks/use-dashboard-filters';
import { useTimesheetSummary } from '@/hooks/use-timesheets';

/**
 * Hours logged this week - or inside the dashboard's date range when one is
 * set - sliced by project, from the timesheet summary endpoint. That endpoint
 * sums the caller's own entries (admins may name one other user), so the
 * dashboard's assignee filter is deliberately not applied here.
 */
export function HoursByProjectWidget() {
  const period = useDashboardHoursWindow();
  const { data, isLoading, isError, refetch } = useTimesheetSummary({
    from: period.from,
    to: period.to,
  });
  const rows = useMemo(() => {
    const items = data?.byProject ?? [];
    return items
      .map((r, i) => ({
        projectId: r.projectId ?? `__none-${i}`,
        label: r.projectName ?? 'No project',
        value: r.totalMinutes,
        color: r.projectColor ?? CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length]!,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
  }, [data]);

  const total = rows.reduce((acc, r) => acc + r.value, 0);

  return (
    <WidgetShell
      id="widget-ws-hours-by-project"
      title="Hours by project"
      subtitle={period.rangeLabel}
      icon={Target}
      linkHref="/timesheets"
    >
      {isLoading ? (
        <Skeleton className="h-44 w-full" />
      ) : isError && !data ? (
        <QueryError compact message="Couldn't load tracked hours." onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <WidgetEmpty
          icon={Target}
          message={
            period.rangeLabel
              ? `No tracked time in ${period.rangeLabel}.`
              : 'No tracked time this week.'
          }
        />
      ) : (
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <div className="relative h-40 w-40 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={rows}
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
                  {rows.map((r) => (
                    <Cell key={r.projectId} fill={r.color} />
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
                    return [fmt(n), label];
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="text-ink text-xl font-bold">{fmt(total)}</div>
                <div className="text-ink-muted text-[10px] uppercase tracking-wide">
                  {period.rangeLabel ? 'in range' : 'this week'}
                </div>
              </div>
            </div>
          </div>
          <ul className="flex-1 space-y-1.5" role="list">
            {rows.slice(0, 6).map((r) => (
              <li key={r.projectId} className="flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: r.color }}
                  />
                  <span className="text-ink truncate">{r.label}</span>
                </span>
                <span className="text-ink shrink-0 font-medium">{fmt(r.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </WidgetShell>
  );
}

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
