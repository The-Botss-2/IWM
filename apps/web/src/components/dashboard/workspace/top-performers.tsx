'use client';

import { Flame, Trophy } from 'lucide-react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useTopPerformers } from '@/hooks/use-workspace-task-stats';

/**
 * Members ranked by tasks completed in the current ISO week. Counted via
 * the assignee on tasks whose `completedAt` (or `updatedAt` fallback)
 * lands inside this week's window, or the dashboard's date range when set. Top 5; rank 1 gets a trophy icon.
 */
export function TopPerformersWidget() {
  const { rows, isLoading, isError, refetch, rangeLabel, truncated } = useTopPerformers(5);

  const max = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;

  return (
    <WidgetShell
      id="widget-ws-top-performers"
      title="Top performers"
      subtitle={rangeLabel}
      icon={Flame}
    >
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : isError ? (
        <QueryError compact message="Couldn't load top performers." onRetry={refetch} />
      ) : rows.length === 0 ? (
        <WidgetEmpty
          icon={Flame}
          message={
            rangeLabel
              ? `No tasks completed in ${rangeLabel}.`
              : 'No tasks completed this week yet.'
          }
        />
      ) : (
        <ul className="space-y-2.5" role="list">
          {rows.map((r, idx) => (
            <li key={r.userId} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-ink-muted grid h-5 w-5 shrink-0 place-items-center text-[11px] font-semibold">
                    {idx === 0 ? (
                      <Trophy className="text-brand-orange h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <>#{idx + 1}</>
                    )}
                  </span>
                  <UserAvatar size="xs" name={r.name} image={r.image} />
                  <span className="text-ink truncate">{r.name}</span>
                </span>
                <span className="text-ink shrink-0 text-xs font-semibold tabular-nums">
                  {r.count}
                </span>
              </div>
              <div className="bg-bg-subtle relative h-1.5 rounded-full" aria-hidden>
                <span
                  className="bg-brand-gradient absolute inset-y-0 left-0 rounded-full"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
          {truncated ? (
            <li className="text-ink-muted text-xs">
              Partial data: ranked from the most recent completions only. Pick a shorter range for
              full counts.
            </li>
          ) : null}
        </ul>
      )}
    </WidgetShell>
  );
}
