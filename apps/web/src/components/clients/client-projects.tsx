'use client';

import { ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ProjectFormDialog } from '@/components/projects/project-form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/lib/ability';
import { useProjects } from '@/hooks/use-projects';
import { relativeTime } from '@/lib/time';

interface Props {
  clientId: string;
}

export function ClientProjects({ clientId }: Props) {
  const projects = useProjects({ clientId, pageSize: 100 });
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-ink text-base font-semibold">Projects</h2>
        <Can I="create" a="Project">
          <Button onClick={() => setDialogOpen(true)} size="sm">
            <Plus className="h-4 w-4" />
            Create project for this client
          </Button>
        </Can>
      </div>

      {projects.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : projects.isError && !projects.data ? (
        <QueryError message="Couldn't load projects." onRetry={() => void projects.refetch()} />
      ) : projects.data?.items.length ? (
        <ul className="divide-line border-line divide-y rounded-lg border bg-white">
          {projects.data.items.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="hover:bg-bg-subtle focus-visible:bg-bg-subtle flex items-center gap-3 p-3 focus-visible:outline-none"
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: p.color ?? '#6366f1' }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ink truncate text-sm font-medium">{p.name}</span>
                    <span className="text-ink-muted font-mono text-xs">{p.key}</span>
                  </div>
                  {p.description ? (
                    <p className="text-ink-muted mt-0.5 line-clamp-1 text-xs">{p.description}</p>
                  ) : null}
                </div>
                <Badge tone={p.status === 'ARCHIVED' ? 'neutral' : 'brand'}>{p.status}</Badge>
                <span className="text-ink-muted hidden text-xs sm:inline">
                  Updated {relativeTime(p.updatedAt)}
                </span>
                <ChevronRight className="text-ink-disabled h-4 w-4" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="border-line rounded-lg border border-dashed bg-white p-10 text-center">
          <p className="text-ink text-sm font-medium">No projects for this client yet.</p>
          <p className="text-ink-muted mt-1 text-sm">
            Start one with the “Create project for this client” button.
          </p>
        </div>
      )}

      {dialogOpen ? (
        <ProjectFormDialog defaultClientId={clientId} onClose={() => setDialogOpen(false)} />
      ) : null}
    </section>
  );
}
