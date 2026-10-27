'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarRange } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

import { useDashboardFilters } from '@/hooks/use-dashboard-filters';

/**
 * Workspace-wide upcoming deadlines - not just the user's own. Shows the
 * 10 soonest open tasks with a due date in the next 14 days, plus any
 * overdue items flagged red at the top.
 */
export function UpcomingDeadlinesWidget() {
  const ws = useCurrentWorkspace();
  const { workspaceId } = useDashboardFilters();
  const effectiveWsId = workspaceId ?? ws.data?.id ?? 'org';
  const dueBefore = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d;
  }, []);
  const q = useQuery({
    queryKey: ['ws-upcoming', effectiveWsId, dueBefore.toISOString()],
    queryFn: () =>
      getApi().tasks.list({
        dueBefore,
        sort: 'dueDate',
        order: 'asc',
        pageSize: 50,
        ...(workspaceId ? { workspaceId } : { aggregate: 'org' }),
      }),
    staleTime: 60_000,
  });

  const items = useMemo(() => {
    return (q.data?.items ?? [])
      .filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED')
      .slice(0, 10);
  }, [q.data]);

  return (
    <WidgetShell
      id="widget-ws-upcoming"
      title="Upcoming deadlines"
      icon={CalendarRange}
    >
      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <QueryError compact message="Couldn't load upcoming deadlines." onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <WidgetEmpty icon={CalendarRange} message="Nothing due in the next 14 days." />
      ) : (
        <ul className="space-y-1" role="list">
          {items.map((t) => {
            const due = t.dueDate ? new Date(t.dueDate) : null;
            const overdue = due ? due.getTime() < Date.now() : false;
            const today = due ? isSameDay(due, new Date()) : false;
            return (
              <li key={t.id}>
                <Link
                  href={`/projects/${t.projectId}`}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-bg-subtle"
                >
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {overdue ? (
                      <AlertTriangle
                        className="mr-1 inline h-3 w-3 text-state-error align-text-bottom"
                        aria-label="Overdue"
                      />
                    ) : null}
                    {t.title}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {t.assignee ? (
                      <UserAvatar
                        size="xs"
                        name={t.assignee.name || t.assignee.email}
                        image={t.assignee.image}
                      />
                    ) : null}
                    {due ? (
                      <span
                        className={cn(
                          'text-[11px] tabular-nums',
                          overdue
                            ? 'font-medium text-state-error'
                            : today
                              ? 'font-medium text-brand-orange'
                              : 'text-ink-muted',
                        )}
                      >
                        {dueLabel(due)}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dueLabel(d: Date): string {
  const now = new Date();
  const diffDays = Math.round(
    (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays < 0) return `${Math.abs(diffDays)}d late`;
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays <= 7) return `${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
