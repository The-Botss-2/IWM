'use client';

import { ArrowRight, FolderKanban, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { ProjectStatus, ProjectWithCreator } from '@botss/shared-types';

import { ProjectFormDialog } from '@/components/projects/project-form-dialog';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { Can } from '@/lib/ability';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useProjects } from '@/hooks/use-projects';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

const STATUS_META: Record<
  ProjectStatus,
  { label: string; pill: string; dot: string }
> = {
  DRAFT: {
    label: 'Draft',
    pill: 'bg-bg-subtle text-ink-muted',
    dot: 'bg-ink-muted',
  },
  ACTIVE: {
    label: 'Active',
    pill: 'border border-brand-teal/30 text-gradient-success',
    dot: 'bg-brand-teal',
  },
  ON_HOLD: {
    label: 'On hold',
    pill: 'bg-tint-warning text-brand-orange',
    dot: 'bg-brand-orange',
  },
  COMPLETED: {
    label: 'Completed',
    pill: 'bg-[#EAF0FC] text-brand-blue',
    dot: 'bg-brand-blue',
  },
  ARCHIVED: {
    label: 'Archived',
    pill: 'bg-bg-subtle text-ink-muted line-through',
    dot: 'bg-line-strong',
  },
};

export default function ProjectsPage() {
  const [dialog, setDialog] = useState(false);
  const [search, setSearch] = useState('');
  // Server-side search: the /projects list endpoint filters by name + key,
  // so pass the (debounced) term through rather than filtering one page.
  const debouncedSearch = useDebouncedValue(search, 250);
  const projects = useProjects({
    pageSize: 50,
    ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
  });
  const workspace = useCurrentWorkspace();
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | 'ALL'>('ALL');
  const items = (projects.data?.items ?? []).filter((p) => {
    if (statusFilter !== 'ALL' && p.status !== statusFilter) return false;
    return true;
  });
  const searching = debouncedSearch.trim().length > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-ink-muted">
            <span className="hover:underline cursor-pointer">Dashboard</span>
            <span className="mx-1">›</span>
            <span className="underline">Projects</span>
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">Projects</h1>
          <p className="text-sm text-ink-muted">
            {workspace.data?.name
              ? `All projects in ${workspace.data.name}.`
              : 'All projects in this workspace.'}
          </p>
        </div>
        <Can I="create" a="Project">
          <Button onClick={() => setDialog(true)}>
            <Plus className="h-4 w-4" />
            New project
          </Button>
        </Can>
      </header>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search projects…"
            aria-label="Search projects"
            className="input h-9 w-full pl-8 text-sm"
          />
        </div>

        {/* Status Filter Chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatusFilter('ALL')}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              statusFilter === 'ALL'
                ? 'bg-brand-50 text-brand-700 font-semibold'
                : 'text-ink-muted hover:bg-bg-subtle hover:text-ink',
            )}
          >
            All
          </button>
          {(Object.keys(STATUS_META) as ProjectStatus[]).map((st) => {
            const meta = STATUS_META[st];
            const active = statusFilter === st;
            return (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(active ? 'ALL' : st)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                  active
                    ? 'border border-brand-purple/30 bg-brand-50 text-brand-700 font-semibold'
                    : 'border border-line hover:bg-bg-subtle text-ink-muted',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>

      {projects.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      ) : projects.isError && !projects.data ? (
        <QueryError
          message="Couldn't load projects."
          onRetry={() => void projects.refetch()}
        />
      ) : items.length === 0 ? (
        searching || statusFilter !== 'ALL' ? (
          <div className="rounded-xl bg-white p-10 text-center text-sm text-ink-muted shadow-soft">
            No projects match your filter.
            <div className="mt-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('ALL');
                }}
              >
                Reset filters
              </Button>
            </div>
          </div>
        ) : (
          <EmptyState onCreate={() => setDialog(true)} />
        )
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}

      {dialog ? <ProjectFormDialog onClose={() => setDialog(false)} /> : null}
    </div>
  );
}

function ProjectCard({ project: p }: { project: ProjectWithCreator }) {
  const status = STATUS_META[p.status] ?? STATUS_META.DRAFT;
  const color = p.color ?? '#7B6FE8';
  const initial = p.name.charAt(0).toUpperCase();
  return (
    <Link
      href={`/projects/${p.id}`}
      className={cn(
        'group relative flex flex-col gap-4 rounded-xl bg-white p-6 shadow-soft transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-soft-lg',
        'focus-visible:outline-none focus-visible:shadow-focus',
      )}
    >
      {/* Header row: project color block + key + status pill */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-base font-semibold text-white shadow-soft"
            style={{ background: color }}
            aria-hidden
          >
            {initial}
          </div>
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">
              {p.key}
            </div>
            <div className="truncate text-base font-semibold text-ink">
              {p.name}
            </div>
          </div>
        </div>
        <span
          className={cn(
            'whitespace-nowrap inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium',
            status.pill,
          )}
        >
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', status.dot)} />
          {status.label}
        </span>
      </div>

      {/* Description (3 lines max) */}
      <p className="min-h-[3em] text-sm text-ink-muted line-clamp-3">
        {p.description ?? (
          <span className="italic text-ink-disabled">No description yet.</span>
        )}
      </p>

      {/* Footer row: creator + last activity + arrow */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          <UserAvatar
            size="xs"
            name={p.createdBy.name || p.createdBy.email}
            image={p.createdBy.image}
          />
          <span className="truncate text-ink-muted">
            {p.createdBy.name || p.createdBy.email}
          </span>
        </div>
        <span className="shrink-0 text-ink-muted">
          {relativeTime(new Date(p.updatedAt))}
        </span>
        <ArrowRight
          className="h-4 w-4 shrink-0 text-ink-disabled transition-all group-hover:translate-x-0.5 group-hover:text-brand-purple"
          aria-hidden
        />
      </div>
    </Link>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl bg-white p-12 text-center shadow-soft">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-brand-gradient-soft">
        <FolderKanban className="h-6 w-6 text-brand-purple" aria-hidden />
      </div>
      <h2 className="text-base font-semibold text-ink">No projects yet</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Create your first project to start tracking tasks, sprints, and time.
      </p>
      <Can I="create" a="Project">
        <Button className="mt-4" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          Create project
        </Button>
      </Can>
    </div>
  );
}
