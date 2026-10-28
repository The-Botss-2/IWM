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
      <p className="text-ink-muted text-sm">
        Saved filters surface as shortcuts here. Use the &ldquo;Save view&rdquo; button in the Board
        / List toolbar to add one. The first time you save a view it appears in the list below.
      </p>

      {views.isLoading ? (
        <Skeleton className="h-32" />
      ) : views.isError && !views.data ? (
        <QueryError message="Couldn't load shortcuts." onRetry={() => void views.refetch()} />
      ) : views.data && views.data.length > 0 ? (
        <ul className="divide-line border-line divide-y rounded-lg border bg-white">
          {views.data.map((v) => (
            <li key={v.id} className="flex items-center gap-3 p-3">
              <Bookmark className="text-ink-disabled h-4 w-4" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-ink text-sm font-medium">{v.name}</div>
                <div className="text-ink-muted truncate text-xs">{describeConfig(v)}</div>
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
                <Trash2 className="text-ink-muted h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-line text-ink-muted rounded-md border border-dashed p-6 text-center text-sm">
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
