'use client';

import { useQuery } from '@tanstack/react-query';
import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { getApi } from '@/lib/api';

export function UpcomingTasksWidget() {
  const dueBefore = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d;
  }, []);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['upcoming-tasks', { dueBefore: dueBefore.toISOString() }],
    queryFn: () =>
      getApi().tasks.list({
        assignedToMe: true,
        dueBefore,
        pageSize: 8,
        sort: 'dueDate',
        order: 'asc',
      }),
    staleTime: 60_000,
  });
  const items = data?.items ?? [];
  return (
    <WidgetShell
      id="widget-upcoming-tasks"
      title="Upcoming Tasks"
      icon={ListChecks}
      linkHref="/projects"
    >
      {isLoading ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : isError ? (
        <QueryError compact onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <WidgetEmpty icon={ListChecks} message="No tasks due in the next 7 days." />
      ) : (
        <ul className="space-y-1.5" role="list">
          {items.map((t) => (
            <li key={t.id}>
              <Link
                href={`/projects/${t.projectId}`}
                className="hover:bg-bg-subtle flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm"
              >
                <span className="text-ink min-w-0 flex-1 truncate">{t.title}</span>
                {t.dueDate ? (
                  <span className="text-ink-muted shrink-0 text-[11px]">
                    {new Date(t.dueDate).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
