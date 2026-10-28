'use client';

import { Clock } from 'lucide-react';
import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useDashboardHoursWindow } from '@/hooks/use-dashboard-filters';
import { useTimesheetSummary } from '@/hooks/use-timesheets';

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function WeeklyHoursWidget() {
  // This week, or the dashboard's date range when one is set.
  const period = useDashboardHoursWindow();
  const { data, isLoading, isError, refetch } = useTimesheetSummary({
    from: period.from,
    to: period.to,
  });
  const rows = data?.byProject ?? [];
  return (
    <WidgetShell
      id="widget-weekly-hours"
      title={period.rangeLabel ? 'Hours' : "This Week's Hours"}
      subtitle={period.rangeLabel}
      icon={Clock}
      linkHref="/timesheets"
    >
      {isLoading ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : isError ? (
        <QueryError compact onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <WidgetEmpty
          icon={Clock}
          message={
            period.rangeLabel
              ? `No tracked time in ${period.rangeLabel}.`
              : 'No tracked time yet this week.'
          }
        />
      ) : (
        <div className="space-y-3">
          <div className="text-ink text-2xl font-semibold">{fmt(data?.totalMinutes ?? 0)}</div>
          <ul className="space-y-1.5" role="list">
            {rows.slice(0, 5).map((r) => (
              <li
                key={r.projectId ?? '__none__'}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: r.projectColor ?? '#94a3b8' }}
                    aria-hidden
                  />
                  <span className="text-ink truncate">{r.projectName ?? 'No project'}</span>
                </span>
                <span className="text-ink shrink-0 font-medium">{fmt(r.totalMinutes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </WidgetShell>
  );
}
