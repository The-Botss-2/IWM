'use client';

import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  FolderKanban,
  TrendingDown,
  TrendingUp,
  UserPlus,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { countOpenLeads, useWorkspaceLeads } from '@/hooks/use-leads';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { useCompletedThisWeek } from '@/hooks/use-workspace-task-stats';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 4-tile KPI strip pinned to the top of the Workspace Summary. Each tile
 * shows a single number with an optional period-over-period delta arrow.
 *
 * All four tiles fetch in parallel and render independently, so a slow
 * leads query doesn't block the projects KPI. Counts are workspace-scoped
 * via the API client's workspace header.
 */
export function WorkspaceKpiStrip() {
  // Leads are gated server-side by sales access (sales role, workspace
  // owner/admin, or an assigned lead). Drop the tile for everyone else so
  // the dashboard doesn't render a tile that's guaranteed to 403 + a stuck
  // spinner.
  const canSeeLeads = useSalesAccess().leads;
  return (
    <div
      className={cn(
        'grid gap-4 sm:grid-cols-2',
        canSeeLeads ? 'lg:grid-cols-4' : 'lg:grid-cols-3',
      )}
      aria-label="Workspace KPIs"
    >
      <ActiveProjectsTile />
      <CompletedThisWeekTile />
      <OverdueTasksTile />
      {canSeeLeads ? <OpenLeadsTile /> : null}
    </div>
  );
}

interface TileProps {
  label: string;
  icon: ReactNode;
  value: ReactNode;
  delta?: { direction: 'up' | 'down' | 'flat'; label: string };
  href?: string;
}

function Tile({ label, icon, value, delta }: TileProps) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-soft transition-shadow duration-200 hover:shadow-soft-lg">
      <div className="flex items-center justify-between text-xs font-medium text-ink-muted">
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {delta ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[11px] font-semibold',
              delta.direction === 'up' && 'text-brand-teal',
              delta.direction === 'down' && 'text-state-error',
              delta.direction === 'flat' && 'text-ink-muted',
            )}
          >
            {delta.direction === 'up' ? (
              <TrendingUp className="h-3 w-3" />
            ) : delta.direction === 'down' ? (
              <TrendingDown className="h-3 w-3" />
            ) : null}
            {delta.label}
          </span>
        ) : null}
      </div>
      <div className="mt-3 text-3xl font-bold text-ink">{value}</div>
    </div>
  );
}

function ErrorValue({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="text-xs font-normal text-ink-muted hover:underline"
    >
      Couldn&apos;t load. Try again
    </button>
  );
}

function ActiveProjectsTile() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  // Server-side count of ACTIVE projects only; draft, on-hold, completed
  // and archived projects are not "active".
  const q = useQuery({
    queryKey: ['ws-kpi', 'projects', 'active', wsId],
    queryFn: () => getApi().projects.list({ status: 'ACTIVE', pageSize: 1 }),
    enabled: !!wsId,
    staleTime: 30_000,
  });
  const count = q.data?.pagination.total ?? 0;
  return (
    <Tile
      label="Active projects"
      icon={<FolderKanban className="h-3.5 w-3.5 text-brand-purple" />}
      value={
        q.isLoading ? (
          <Skeleton className="h-8 w-12" />
        ) : q.isError && !q.data ? (
          <ErrorValue onRetry={() => void q.refetch()} />
        ) : (
          count
        )
      }
    />
  );
}

function CompletedThisWeekTile() {
  // Reads the shared workspace done-tasks query (see use-workspace-task-stats).
  const { thisWeek, delta, isLoading, isError, refetch, rangeLabel } = useCompletedThisWeek();
  return (
    <Tile
      label={rangeLabel ? `Completed ${rangeLabel}` : 'Completed this week'}
      icon={<CheckCircle2 className="h-3.5 w-3.5 text-brand-teal" />}
      value={
        isLoading ? (
          <Skeleton className="h-8 w-12" />
        ) : isError ? (
          <ErrorValue onRetry={refetch} />
        ) : (
          thisWeek
        )
      }
      delta={isError ? undefined : delta}
    />
  );
}

function OverdueTasksTile() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  const dueBefore = useMemo(() => new Date(), []);
  const q = useQuery({
    queryKey: ['ws-kpi', 'overdue', wsId],
    queryFn: () =>
      getApi().tasks.list({
        dueBefore,
        sort: 'dueDate',
        order: 'asc',
        pageSize: 500,
      }),
    enabled: !!wsId,
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  const open = items.filter(
    (t) => t.status !== 'DONE' && t.status !== 'CANCELLED',
  ).length;
  return (
    <Tile
      label="Overdue tasks"
      icon={<AlertTriangle className="h-3.5 w-3.5 text-state-error" />}
      value={
        q.isLoading ? (
          <Skeleton className="h-8 w-12" />
        ) : q.isError && !q.data ? (
          <ErrorValue onRetry={() => void q.refetch()} />
        ) : (
          <span className={open > 0 ? 'text-state-error' : undefined}>
            {open}
          </span>
        )
      }
    />
  );
}

function OpenLeadsTile() {
  // Shares one cached lead list with the lead-funnel widget.
  const q = useWorkspaceLeads();
  const open = useMemo(() => countOpenLeads(q.data?.items ?? []), [q.data]);
  return (
    <Tile
      label="Open leads"
      icon={<UserPlus className="h-3.5 w-3.5 text-brand-orange" />}
      value={
        q.isLoading ? (
          <Skeleton className="h-8 w-12" />
        ) : q.isError && !q.data ? (
          <ErrorValue onRetry={() => void q.refetch()} />
        ) : (
          open
        )
      }
    />
  );
}

