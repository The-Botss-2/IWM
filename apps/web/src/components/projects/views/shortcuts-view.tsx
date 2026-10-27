'use client';

import { Bookmark, Trash2 } from 'lucide-react';
import type { SavedView } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useDeleteSavedView, useSavedViews } from '@/hooks/use-saved-views';
import { toast } from '@/lib/toast';

export default function ShortcutsView({ projectId }: { projectId: string }) {
  const views = useSavedViews(projectId);
  const remove = useDeleteSavedView(projectId);

  return (
    <section className="space-y-4">
      <p className="text-sm text-ink-muted">
        Saved filters surface as shortcuts here. Use the &ldquo;Save view&rdquo; button in the
        Board / List toolbar to add one. The first time you save a view it appears in the list
        below.
      </p>

      {views.isLoading ? (
        <Skeleton className="h-32" />
      ) : views.isError && !views.data ? (
        <QueryError message="Couldn't load shortcuts." onRetry={() => void views.refetch()} />
      ) : views.data && views.data.length > 0 ? (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {views.data.map((v) => (
            <li key={v.id} className="flex items-center gap-3 p-3">
              <Bookmark className="h-4 w-4 text-ink-disabled" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">{v.name}</div>
                <div className="truncate text-xs text-ink-muted">
                  {describeConfig(v)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete shortcut ${v.name}`}
                onClick={() => {
                  if (confirm(`Delete shortcut "${v.name}"?`)) {
                    remove.mutate(v.id, {
                      onSuccess: () => toast.success(`Shortcut "${v.name}" deleted.`),
                    });
                  }
                }}
              >
                <Trash2 className="h-4 w-4 text-ink-muted" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
          No saved views yet.
        </div>
      )}
    </section>
  );
}

function describeConfig(v: SavedView): string {
  const parts: string[] = [];
  if (v.config.viewType) parts.push(v.config.viewType);
  if (v.config.groupBy && v.config.groupBy !== 'none') parts.push(`group by ${v.config.groupBy}`);
  if (v.config.filter?.status?.length) parts.push(`status: ${v.config.filter.status.join(', ')}`);
  if (v.isShared) parts.push('shared');
  return parts.join(' · ') || 'No filters';
}
