'use client';

import { RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useArchivedTasks, useRestoreTask } from '@/hooks/use-archived-tasks';
import { relativeTime } from '@/lib/time';

export default function ArchiveView({ projectId }: { projectId: string }) {
  const archived = useArchivedTasks(projectId);
  const restore = useRestoreTask(projectId);

  return (
    <section className="space-y-3">
      <p className="text-sm text-ink-muted">
        Soft-deleted and cancelled tasks live here. Restore to put them back in the backlog.
      </p>
      {archived.isLoading ? (
        <Skeleton className="h-32" />
      ) : archived.isError && !archived.data ? (
        <QueryError message="Couldn't load archived tasks." onRetry={() => void archived.refetch()} />
      ) : archived.data && archived.data.items.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {archived.data.items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{t.title}</div>
                <div className="text-xs text-ink-muted">
                  <Badge tone="neutral">{t.deletedAt ? 'archived' : t.status.toLowerCase()}</Badge>{' '}
                  <span title={t.updatedAt ? new Date(t.updatedAt).toISOString() : undefined}>
                    {relativeTime((t.deletedAt ?? t.updatedAt) as Date)}
                  </span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => restore.mutate(t.id)}
                disabled={restore.isPending}
              >
                <RotateCcw className="h-4 w-4" /> Restore
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
          Nothing archived.
        </div>
      )}
    </section>
  );
}
