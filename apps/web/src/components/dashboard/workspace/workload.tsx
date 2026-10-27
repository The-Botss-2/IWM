'use client';

import { Users } from 'lucide-react';

import { CHART_COLORS } from '@/components/dashboard/workspace/colors';
import { WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useWorkload } from '@/hooks/use-workspace-task-stats';

/**
 * Horizontal bar chart: open task count per workspace member. Bar length
 * scales to the heaviest workload; an overdue overlay segment surfaces
 * stress points. Unassigned tasks bucket under a "-" row. Done and
 * cancelled tasks are not counted, so the total is lower than the
 * "Tasks by status" donut by exactly those two slices.
 */
export function WorkloadWidget() {
  const q = useWorkload();
  const rows = q.data?.rows ?? [];
  const openTotal = q.data?.openTotal ?? 0;
  const groupCount = q.data?.groupCount ?? 0;

  const max = rows.reduce((m, r) => Math.max(m, r.open), 0) || 1;

  return (
    <WidgetShell id="widget-ws-workload" title="Open tasks by member" icon={Users}>
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <QueryError compact message="Couldn't load workload." onRetry={() => void q.refetch()} />
      ) : rows.length === 0 ? (
        <div className="grid h-32 place-items-center text-xs text-ink-muted">
          No open work assigned.
        </div>
      ) : (
        <>
          <ul className="space-y-2.5" role="list">
            {rows.map((r) => {
              const widthPct = (r.open / max) * 100;
              const overduePct = r.open === 0 ? 0 : (r.overdue / r.open) * 100;
              return (
                <li key={r.userId ?? '__unassigned__'} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      {r.userId ? (
                        <UserAvatar size="xs" name={r.name} image={r.image} />
                      ) : (
                        <span className="grid h-5 w-5 place-items-center rounded-full bg-bg-subtle text-[10px] text-ink-muted">
                          -
                        </span>
                      )}
                      <span className="truncate text-ink">{r.name}</span>
                    </span>
                    <span className="shrink-0 font-medium text-ink">
                      {r.open}
                      {r.overdue > 0 ? (
                        <span className="ml-1 text-[10px] font-normal text-state-error">
                          ({r.overdue} late)
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div
                    className="relative h-2 rounded-full bg-bg-subtle"
                    aria-hidden
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient"
                      style={{ width: `${widthPct}%` }}
                    />
                    {r.overdue > 0 ? (
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{
                          width: `${(widthPct * overduePct) / 100}%`,
                          background: CHART_COLORS.ink,
                          opacity: 0.25,
                        }}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-ink-muted">
            {openTotal} open {openTotal === 1 ? 'task' : 'tasks'} (done and cancelled not counted).
            {groupCount > rows.length ? ` Top ${rows.length} of ${groupCount} shown.` : null}
          </p>
        </>
      )}
    </WidgetShell>
  );
}
