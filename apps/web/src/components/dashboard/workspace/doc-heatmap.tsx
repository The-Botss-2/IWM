'use client';

import { useQuery } from '@tanstack/react-query';
import { FileClock } from 'lucide-react';
import { useMemo } from 'react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const WEEKS = 12;
const DAY_LABELS = ['Mon', 'Wed', 'Fri'];

/**
 * GitHub-style activity heatmap of document edits across the last 12 weeks.
 * Without a dedicated activity log we count edits by document `updatedAt` -
 * imperfect (an edit-then-edit-an-hour-later collapses into one cell), but
 * directionally honest for "is the team writing docs?".
 */
export function DocActivityHeatmapWidget() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  const q = useQuery({
    queryKey: ['ws-doc-activity', wsId],
    queryFn: () =>
      getApi().documents.list({
        sort: 'updatedAt',
        order: 'desc',
        pageSize: 500,
      }),
    enabled: !!wsId,
    staleTime: 60_000,
  });

  const { grid, maxCount, totalCount } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of q.data?.items ?? []) {
      const ts = new Date((d as { updatedAt: Date | string }).updatedAt);
      const key = dayKey(ts);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startMonday = startOfIsoWeek(today);
    // Walk back WEEKS-1 weeks to get a 12-week (84-day) window ending today.
    const gridStart = new Date(startMonday);
    gridStart.setDate(gridStart.getDate() - 7 * (WEEKS - 1));
    const cols: { weekStart: Date; days: { date: Date; count: number; key: string }[] }[] = [];
    for (let w = 0; w < WEEKS; w++) {
      const weekStart = new Date(gridStart);
      weekStart.setDate(weekStart.getDate() + 7 * w);
      const days: { date: Date; count: number; key: string }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(weekStart);
        date.setDate(date.getDate() + d);
        const key = dayKey(date);
        days.push({ date, count: counts.get(key) ?? 0, key });
      }
      cols.push({ weekStart, days });
    }
    let max = 0;
    let total = 0;
    for (const c of cols) {
      for (const d of c.days) {
        if (d.count > max) max = d.count;
        total += d.count;
      }
    }
    return { grid: cols, maxCount: max, totalCount: total };
  }, [q.data]);

  return (
    <WidgetShell
      id="widget-ws-doc-heatmap"
      title="Document activity"
      icon={FileClock}
      linkHref="/documents"
    >
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : q.isError && !q.data ? (
        <QueryError compact message="Couldn't load document activity." onRetry={() => void q.refetch()} />
      ) : totalCount === 0 ? (
        <WidgetEmpty icon={FileClock} message="No document edits in the last 12 weeks." />
      ) : (
        <>
          <div className="mb-2 flex items-baseline justify-between">
            <div>
              <div className="text-2xl font-bold text-ink">{totalCount}</div>
              <div className="text-[11px] text-ink-muted">edits in 12 weeks</div>
            </div>
            <Legend />
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            <div className="flex flex-col justify-between py-1 text-[9px] text-ink-muted">
              {DAY_LABELS.map((l) => (
                <span key={l}>{l}</span>
              ))}
            </div>
            <div className="flex gap-[3px]">
              {grid.map((col, ci) => (
                <div key={ci} className="flex flex-col gap-[3px]">
                  {col.days.map((d) => (
                    <span
                      key={d.key}
                      title={`${d.date.toDateString()}: ${d.count} ${d.count === 1 ? 'edit' : 'edits'}`}
                      className={cn(
                        'h-3 w-3 rounded-[2px]',
                        intensityClass(d.count, maxCount),
                      )}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </WidgetShell>
  );
}

function intensityClass(count: number, max: number): string {
  if (count === 0) return 'bg-bg-subtle';
  if (max === 0) return 'bg-bg-subtle';
  const ratio = count / max;
  if (ratio < 0.25) return 'bg-brand-purple/25';
  if (ratio < 0.5) return 'bg-brand-purple/55';
  if (ratio < 0.75) return 'bg-brand-magenta/75';
  return 'bg-brand-magenta';
}

function Legend() {
  return (
    <div className="flex items-center gap-1 text-[10px] text-ink-muted">
      <span>less</span>
      <span className="h-2.5 w-2.5 rounded-[2px] bg-bg-subtle" aria-hidden />
      <span className="h-2.5 w-2.5 rounded-[2px] bg-brand-purple/25" aria-hidden />
      <span className="h-2.5 w-2.5 rounded-[2px] bg-brand-purple/55" aria-hidden />
      <span className="h-2.5 w-2.5 rounded-[2px] bg-brand-magenta/75" aria-hidden />
      <span className="h-2.5 w-2.5 rounded-[2px] bg-brand-magenta" aria-hidden />
      <span>more</span>
    </div>
  );
}

function startOfIsoWeek(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
