'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, CheckCircle2, Circle, PauseCircle, PlusCircle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import type { TaskWithPeople } from '@botss/shared-types';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { relativeTime } from '@/lib/time';

/**
 * Recent activity feed. The repo doesn't (yet) emit a unified activity log,
 * so the feed is reconstructed from the last 25 updated tasks - completion,
 * creation, and in-progress transitions cover the highest-signal events.
 * Sorted by `updatedAt` descending.
 */
export function ActivityFeedWidget() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  const q = useQuery({
    queryKey: ['ws-activity', wsId],
    queryFn: () =>
      getApi().tasks.list({
        sort: 'updatedAt',
        order: 'desc',
        pageSize: 25,
      }),
    enabled: !!wsId,
    staleTime: 30_000,
  });

  const items = useMemo(() => {
    return (q.data?.items ?? []).slice(0, 12).map(asActivityEntry);
  }, [q.data]);

  return (
    <WidgetShell id="widget-ws-activity" title="Recent activity" icon={Activity}>
      {q.isLoading ? (
        <div className="space-y-2.5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : q.isError && !q.data ? (
        <QueryError
          compact
          message="Couldn't load recent activity."
          onRetry={() => void q.refetch()}
        />
      ) : items.length === 0 ? (
        <WidgetEmpty icon={Activity} message="No recent activity." />
      ) : (
        <ul className="space-y-2" role="list">
          {items.map((it) => (
            <li key={it.taskId}>
              <Link
                href={`/projects/${it.projectId}`}
                className="hover:bg-bg-subtle flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors"
              >
                {it.actor ? (
                  <UserAvatar size="xs" name={it.actor.name} image={it.actor.image} />
                ) : (
                  <span className="bg-bg-subtle text-ink-muted mt-0.5 grid h-5 w-5 place-items-center rounded-full">
                    {it.icon}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-ink text-xs leading-snug">
                    <span className="font-medium">{it.actor?.name ?? 'Someone'}</span>
                    <span className="text-ink-muted"> {it.verb} </span>
                    <span className="font-medium">{it.title}</span>
                  </div>
                  <div className="text-ink-muted mt-0.5 text-[10px]">{relativeTime(it.when)}</div>
                </div>
                <span className="mt-0.5 shrink-0">{it.icon}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

interface ActivityEntry {
  taskId: string;
  projectId: string;
  title: string;
  verb: string;
  icon: ReactNode;
  actor: { name: string; image: string | null } | null;
  when: Date;
}

function asActivityEntry(t: TaskWithPeople): ActivityEntry {
  // Pick the actor we have on the row. The current API surface doesn't
  // separately track *who* did each transition, so we surface the assignee
  // for status moves and the creator for new rows. Imperfect but the best
  // available with the existing shape.
  const isNew = Math.abs(new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime()) < 1500;
  let verb = 'updated';
  let icon: ReactNode = <Circle className="text-ink-muted h-3.5 w-3.5" aria-hidden />;
  if (isNew) {
    verb = 'created';
    icon = <PlusCircle className="text-brand-purple h-3.5 w-3.5" aria-hidden />;
  } else if (t.status === 'DONE') {
    verb = 'completed';
    icon = <CheckCircle2 className="text-brand-teal h-3.5 w-3.5" aria-hidden />;
  } else if (t.status === 'CANCELLED') {
    verb = 'cancelled';
    icon = <PauseCircle className="text-state-error h-3.5 w-3.5" aria-hidden />;
  } else if (t.status === 'IN_PROGRESS') {
    verb = 'started';
    icon = <Circle className="text-brand-blue h-3.5 w-3.5 fill-current" aria-hidden />;
  }
  const actor = isNew
    ? t.createdBy
      ? { name: t.createdBy.name, image: t.createdBy.image }
      : null
    : t.assignee
      ? { name: t.assignee.name, image: t.assignee.image }
      : t.createdBy
        ? { name: t.createdBy.name, image: t.createdBy.image }
        : null;
  return {
    taskId: t.id,
    projectId: t.projectId,
    title: t.title,
    verb,
    icon,
    actor,
    when: new Date(t.updatedAt),
  };
}
