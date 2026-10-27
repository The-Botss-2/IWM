'use client';

import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import type { TaskWithPeople } from '@botss/shared-types';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { relativeTime } from '@/lib/time';

interface UserGroup {
  userId: string;
  name: string;
  image: string | null;
  tasks: TaskWithPeople[];
}

/**
 * Latest tasks grouped by assignee - 3 most-recent per person, top 4
 * people by recency. Lets a lead see at a glance what each teammate has
 * touched lately without opening a project board.
 */
export function RecentByUserWidget() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  const q = useQuery({
    queryKey: ['ws-recent-by-user', wsId],
    queryFn: () =>
      getApi().tasks.list({
        sort: 'updatedAt',
        order: 'desc',
        pageSize: 100,
      }),
    enabled: !!wsId,
    staleTime: 60_000,
  });

  const groups = useMemo<UserGroup[]>(() => {
    const items = q.data?.items ?? [];
    const seenOrder: string[] = [];
    const map = new Map<string, UserGroup>();
    for (const t of items) {
      if (!t.assignee) continue;
      const id = t.assignee.id;
      let g = map.get(id);
      if (!g) {
        g = {
          userId: id,
          name: t.assignee.name || t.assignee.email,
          image: t.assignee.image,
          tasks: [],
        };
        map.set(id, g);
        seenOrder.push(id);
      }
      if (g.tasks.length < 3) g.tasks.push(t);
    }
    return seenOrder
      .slice(0, 4)
      .map((id) => map.get(id))
      .filter((g): g is UserGroup => !!g);
  }, [q.data]);

  return (
    <WidgetShell id="widget-ws-recent-by-user" title="Recent tasks by user" icon={Users}>
      {q.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <QueryError compact message="Couldn't load recent tasks." onRetry={() => void q.refetch()} />
      ) : groups.length === 0 ? (
        <WidgetEmpty icon={Users} message="No assigned task activity yet." />
      ) : (
        <ul className="space-y-4" role="list">
          {groups.map((g) => (
            <li key={g.userId}>
              <div className="mb-1.5 flex items-center gap-2">
                <UserAvatar size="sm" name={g.name} image={g.image} />
                <span className="text-xs font-semibold text-ink">{g.name}</span>
                <span className="text-[10px] text-ink-muted">
                  {g.tasks.length} {g.tasks.length === 1 ? 'task' : 'tasks'}
                </span>
              </div>
              <ul className="space-y-0.5 pl-9" role="list">
                {g.tasks.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/projects/${t.projectId}`}
                      className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-bg-subtle"
                    >
                      <span className="truncate text-ink">{t.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-muted">
                        {relativeTime(new Date(t.updatedAt))}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
