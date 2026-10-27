'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';
import type { SprintWithStats, TaskWithPeople } from '@botss/shared-types';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface ActiveSprint {
  projectId: string;
  projectName: string;
  sprint: SprintWithStats;
  doneCount: number;
}

/**
 * Workspace-wide sprint progress. Walks the active sprints across every
 * project the workspace owns, then shows a card per sprint with done/total
 * + days remaining. A daily burndown line would need historical snapshots
 * the API doesn't store, so this is the most honest summary we can build
 * today.
 */
export function SprintProgressWidget() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';

  const projectsQ = useQuery({
    queryKey: ['ws-sprint-projects', wsId],
    queryFn: () => getApi().projects.list({ pageSize: 200 }),
    enabled: !!wsId,
    staleTime: 60_000,
  });
  const projects = useMemo(
    () => (projectsQ.data?.items ?? []).filter((p) => !p.deletedAt),
    [projectsQ.data],
  );

  const sprintQueries = useQueries({
    queries: projects.map((p) => ({
      queryKey: ['sprints', p.id],
      queryFn: () => getApi().sprints.list(p.id),
      staleTime: 60_000,
      enabled: !!wsId,
    })),
  });

  const activeSprints = useMemo(() => {
    const out: { projectId: string; projectName: string; sprint: SprintWithStats }[] = [];
    sprintQueries.forEach((q, i) => {
      const project = projects[i];
      if (!project) return;
      for (const s of q.data ?? []) {
        if (s.status === 'ACTIVE') {
          out.push({ projectId: project.id, projectName: project.name, sprint: s });
        }
      }
    });
    // Sort by end date ascending so the soonest-deadline sprint surfaces first.
    return out
      .sort(
        (a, b) =>
          new Date(a.sprint.endDate).getTime() -
          new Date(b.sprint.endDate).getTime(),
      )
      .slice(0, 4);
  }, [projects, sprintQueries]);

  // Pull task lists for the projects with active sprints so we can count DONE
  // tasks per sprint (taskIds × DONE set intersection).
  const taskQueries = useQueries({
    queries: activeSprints
      .map((s) => s.projectId)
      .filter((id, idx, arr) => arr.indexOf(id) === idx)
      .map((projectId) => ({
        queryKey: ['ws-sprint-tasks', projectId],
        queryFn: () =>
          getApi().tasks.list({
            projectId,
            pageSize: 500,
          }),
        staleTime: 60_000,
        enabled: !!wsId,
      })),
  });

  const cards = useMemo<ActiveSprint[]>(() => {
    const tasksByProject = new Map<string, TaskWithPeople[]>();
    taskQueries.forEach((q, i) => {
      const projectId = [
        ...new Set(activeSprints.map((s) => s.projectId)),
      ][i];
      if (!projectId) return;
      tasksByProject.set(projectId, q.data?.items ?? []);
    });
    return activeSprints.map(({ projectId, projectName, sprint }) => {
      const tasks = tasksByProject.get(projectId) ?? [];
      const taskIdSet = new Set(sprint.taskIds);
      const done = tasks.filter(
        (t) => taskIdSet.has(t.id) && t.status === 'DONE',
      ).length;
      return { projectId, projectName, sprint, doneCount: done };
    });
  }, [activeSprints, taskQueries]);

  const loading =
    projectsQ.isLoading ||
    sprintQueries.some((q) => q.isLoading) ||
    taskQueries.some((q) => q.isLoading);

  const failed = projectsQ.isError && !projectsQ.data;

  return (
    <WidgetShell
      id="widget-ws-sprint-progress"
      title="Sprint progress"
      icon={GitBranch}
    >
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : failed ? (
        <QueryError compact message="Couldn't load sprint progress." onRetry={() => void projectsQ.refetch()} />
      ) : cards.length === 0 ? (
        <WidgetEmpty icon={GitBranch} message="No active sprints right now." />
      ) : (
        <ul className="space-y-3" role="list">
          {cards.map((c) => (
            <SprintCard key={c.sprint.id} card={c} />
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

function SprintCard({ card }: { card: ActiveSprint }) {
  const { sprint, projectName, projectId, doneCount } = card;
  const total = sprint.taskCount;
  const pct = total === 0 ? 0 : Math.round((doneCount / total) * 100);
  const now = Date.now();
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate).getTime();
  const totalDays = Math.max(1, Math.round((end - start) / 86_400_000));
  const daysRemaining = Math.max(
    0,
    Math.ceil((end - now) / 86_400_000),
  );
  const overdue = now > end && doneCount < total;
  // Pace = expected % at this point in time. Used to flag sprints where
  // completion is lagging the calendar.
  const elapsedPct = Math.max(
    0,
    Math.min(100, Math.round(((now - start) / (end - start)) * 100)),
  );
  const behind = pct < elapsedPct - 15 && total > 0;
  return (
    <li className="rounded-lg border border-line bg-white p-3 transition-shadow hover:shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">{sprint.name}</div>
          <Link
            href={`/projects/${projectId}?view=backlog`}
            className="text-[11px] text-ink-muted hover:underline"
          >
            {projectName}
          </Link>
        </div>
        <span
          className={cn(
            'whitespace-nowrap shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
            overdue
              ? 'bg-tint-error text-state-error'
              : behind
                ? 'bg-tint-warning text-brand-orange'
                : 'bg-tint-info text-brand-teal',
          )}
        >
          {overdue
            ? 'Overdue'
            : daysRemaining === 0
              ? 'Ends today'
              : `${daysRemaining}d left`}
        </span>
      </div>
      <div className="mt-2.5 flex items-center justify-between text-xs">
        <span className="text-ink-muted">
          {doneCount}/{total} {total === 1 ? 'task' : 'tasks'}
        </span>
        <span className="font-semibold text-ink tabular-nums">{pct}%</span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-bg-subtle" aria-hidden>
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-brand-gradient"
          style={{ width: `${pct}%` }}
        />
        <span
          aria-hidden
          className="absolute inset-y-0 w-px bg-ink/30"
          style={{ left: `${elapsedPct}%` }}
          title={`Day ${Math.round((elapsedPct * totalDays) / 100)} of ${totalDays}`}
        />
      </div>
    </li>
  );
}
