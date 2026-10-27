'use client';

import { GitBranch } from 'lucide-react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { use, useCallback, useMemo, useState } from 'react';

import { ProjectSettingsView } from '@/components/projects/project-settings-view';
import { ProjectViewTabs, useProjectView } from '@/components/projects/project-view-tabs';
import { BoardView } from '@/components/projects/views/board-view';
import type { ViewSnapshot } from '@/components/projects/views/saved-views-menu';
import { TaskToolbar } from '@/components/tasks/task-toolbar';
import { TaskListView } from '@/components/tasks/task-list-view';
import { Skeleton } from '@/components/ui/skeleton';
import {
  isListColumn,
  useBoardDensity,
  useBoardGroupBy,
  useListColumns,
  useListGroupBy,
  type BoardGroupBy,
  type ListGroupBy,
} from '@/hooks/use-board-prefs';
import { useNotificationAutoRead } from '@/hooks/use-notifications';
import { useProject } from '@/hooks/use-projects';
import { useSprints } from '@/hooks/use-sprints';
import { matchesTaskFilters, useTaskFilters } from '@/hooks/use-task-filters';
import { useTasks } from '@/hooks/use-tasks';
import { buildTasksCsv, csvFilename, downloadCsv } from '@/lib/csv';

const SummaryView = dynamic(() => import('@/components/projects/views/summary-view'), {
  loading: () => <Skeleton className="h-72" />,
});
const BacklogView = dynamic(() => import('@/components/projects/views/backlog-view'), {
  loading: () => <Skeleton className="h-72" />,
});
const TimelineView = dynamic(() => import('@/components/projects/views/timeline-view'), {
  loading: () => <Skeleton className="h-72" />,
});
const CalendarView = dynamic(() => import('@/components/projects/views/calendar-view'), {
  loading: () => <Skeleton className="h-72" />,
});
const FormsView = dynamic(() => import('@/components/projects/views/forms-view'), {
  loading: () => <Skeleton className="h-48" />,
});
const GoalsView = dynamic(() => import('@/components/projects/views/goals-view'), {
  loading: () => <Skeleton className="h-72" />,
});
const ShortcutsView = dynamic(() => import('@/components/projects/views/shortcuts-view'), {
  loading: () => <Skeleton className="h-48" />,
});
const ArchiveView = dynamic(() => import('@/components/projects/views/archive-view'), {
  loading: () => <Skeleton className="h-48" />,
});
// The task detail sheet (comments, activity, editors) is only needed once a
// task is opened, so it's split out of the board's first-load bundle.
const TaskDetailPanel = dynamic(
  () =>
    import('@/components/tasks/task-detail-panel').then((m) => ({
      default: m.TaskDetailPanel,
    })),
  { ssr: false },
);
const ProjectTodosView = dynamic(
  () =>
    import('@/components/todos/project-todos-view').then((m) => ({
      default: m.ProjectTodosView,
    })),
  { loading: () => <Skeleton className="h-72" /> },
);

export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const project = useProject(id);
  const { view, setView } = useProjectView();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Contextual auto-read: opening the project clears "added to project" /
  // goal notifications; opening a task panel clears that task's notifications
  // (assigned, completed, comments).
  useNotificationAutoRead('project', id);
  useNotificationAutoRead('task', selectedTaskId);

  const tasks = useTasks({ projectId: id, pageSize: 200 });
  const sprints = useSprints(id);

  const selectedTask = useMemo(
    () => tasks.data?.items.find((t) => t.id === selectedTaskId) ?? null,
    [tasks.data, selectedTaskId],
  );
  // Lazily mount the (dynamically imported) detail panel the first time a
  // task is opened. Adjusting state during render is React's recommended
  // pattern for state derived from a transition like this.
  const [detailPanelMounted, setDetailPanelMounted] = useState(false);
  if (selectedTask && !detailPanelMounted) setDetailPanelMounted(true);

  const { filters, setAll: setFilters, clearAll: clearFilters } = useTaskFilters();
  const { density, setDensity } = useBoardDensity();
  const { groupBy: boardGroupBy, setGroupBy: setBoardGroupBy } = useBoardGroupBy(id);
  const { groupBy: listGroupBy, setGroupBy: setListGroupBy } = useListGroupBy(id);
  const { columns: listColumns, setColumns: setListColumns } = useListColumns(id);

  const filtersConfig = useMemo(
    () => ({
      search: filters.search || undefined,
      status: filters.status.length ? filters.status : undefined,
      priority: filters.priority.length ? filters.priority : undefined,
      assigneeIds: filters.assigneeIds.length ? filters.assigneeIds : undefined,
    }),
    [filters],
  );

  // Saved-view "groupBy" is a union of board + list values; project the local
  // state into the shared shape, mapping board's 'epic' to undefined since the
  // saved-view enum doesn't carry it (saved views are filters + columns first;
  // densities and exotic groupings are best-effort).
  const boardSnapshot: ViewSnapshot = useMemo(
    () => ({
      viewType: 'board',
      filter: filtersConfig,
      groupBy:
        boardGroupBy === 'assignee'
          ? 'assignee'
          : boardGroupBy === 'priority'
            ? 'priority'
            : 'none',
      density,
    }),
    [filtersConfig, boardGroupBy, density],
  );

  const listSnapshot: ViewSnapshot = useMemo(
    () => ({
      viewType: 'list',
      filter: filtersConfig,
      columns: listColumns,
      groupBy: listGroupBy,
    }),
    [filtersConfig, listColumns, listGroupBy],
  );

  const onApplyBoardSavedView = useCallback(
    (snap: ViewSnapshot | null) => {
      if (!snap) return;
      if (snap.density) setDensity(snap.density);
      const next = snap.groupBy;
      if (next === 'none' || next === 'assignee' || next === 'priority') {
        setBoardGroupBy(next as BoardGroupBy);
      }
    },
    [setDensity, setBoardGroupBy],
  );

  const onApplyListSavedView = useCallback(
    (snap: ViewSnapshot | null) => {
      if (!snap) return;
      if (snap.columns && snap.columns.length > 0) {
        const filtered = snap.columns.filter(isListColumn);
        if (filtered.length > 0) setListColumns(filtered);
      }
      const g = snap.groupBy;
      if (g === 'none' || g === 'status' || g === 'assignee' || g === 'priority' || g === 'sprint') {
        setListGroupBy(g as ListGroupBy);
      }
    },
    [setListColumns, setListGroupBy],
  );

  if (project.isLoading) {
    return (
      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-10 w-full max-w-md" />
        <div className="flex gap-3 overflow-hidden">
          <Skeleton className="h-40 w-72" />
          <Skeleton className="h-40 w-72" />
          <Skeleton className="h-40 w-72" />
        </div>
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6 text-sm text-state-error sm:px-6 lg:px-8">
        Couldn&apos;t load project.{' '}
        <Link href="/projects" className="underline">
          Back
        </Link>
      </div>
    );
  }
  const p = project.data;

  const exportCsv = () => {
    const visibleTasks = (tasks.data?.items ?? []).filter((t) =>
      matchesTaskFilters(t, filters),
    );
    const csv = buildTasksCsv(visibleTasks, listColumns, sprints.data ?? []);
    downloadCsv(csvFilename(p.key), csv);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <Link href="/projects" className="text-sm text-ink-muted hover:text-ink">
          ← Projects
        </Link>
      </div>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <span
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: p.color ?? '#6366f1' }}
              aria-hidden
            />
            <h1 className="text-xl font-semibold">{p.name}</h1>
            <span className="font-mono text-xs text-ink-muted">{p.key}</span>
          </div>
          {p.description ? (
            <p className="mt-1 max-w-2xl text-sm text-ink-muted">{p.description}</p>
          ) : null}
        </div>
      </header>

      <ProjectViewTabs view={view} onChange={setView} />

      {view === 'board' ? (
        <TaskToolbar
          variant="board"
          projectId={id}
          filters={filters}
          onChangeFilters={setFilters}
          onClearFilters={clearFilters}
          density={density}
          onChangeDensity={setDensity}
          groupBy={boardGroupBy}
          onChangeGroupBy={setBoardGroupBy}
          snapshot={boardSnapshot}
          onApplySavedView={onApplyBoardSavedView}
        />
      ) : null}
      {view === 'list' ? (
        <TaskToolbar
          variant="list"
          projectId={id}
          filters={filters}
          onChangeFilters={setFilters}
          onClearFilters={clearFilters}
          groupBy={listGroupBy}
          onChangeGroupBy={setListGroupBy}
          columns={listColumns}
          onChangeColumns={setListColumns}
          onExportCsv={exportCsv}
          snapshot={listSnapshot}
          onApplySavedView={onApplyListSavedView}
        />
      ) : null}

      <div role="region" aria-label={`${view} view`}>
        {view === 'summary' && <SummaryView projectId={id} />}
        {view === 'board' && (
          <BoardView
            projectId={id}
            project={p}
            density={density}
            groupBy={boardGroupBy}
            filters={filters}
            onSelectTask={setSelectedTaskId}
          />
        )}
        {view === 'list' && (
          <TaskListView
            projectId={id}
            filters={filters}
            groupBy={listGroupBy}
            columns={listColumns}
            onSelect={setSelectedTaskId}
          />
        )}
        {view === 'backlog' && <BacklogView projectId={id} />}
        {view === 'timeline' && (
          <TimelineView projectId={id} onSelectTask={setSelectedTaskId} />
        )}
        {view === 'calendar' && (
          <CalendarView projectId={id} onSelectTask={setSelectedTaskId} />
        )}
        {view === 'forms' && <FormsView projectId={id} />}
        {view === 'goals' && <GoalsView projectId={id} />}
        {view === 'todos' && (
          <ProjectTodosView projectId={id} workspaceId={p.workspaceId} />
        )}
        {view === 'shortcuts' && <ShortcutsView projectId={id} />}
        {view === 'archive' && <ArchiveView projectId={id} />}
        {view === 'development' && (
          <ComingSoon
            icon={<GitBranch className="h-5 w-5" />}
            title="Development"
            description="Git provider integration arrives in Phase 3 - link PRs, branches, and reviews to tasks."
          />
        )}
        {view === 'code' && (
          <ComingSoon
            icon={<GitBranch className="h-5 w-5" />}
            title="Code"
            description="Repository browser in-app. Coming with the Phase 3 git integration."
          />
        )}
        {view === 'settings' && <ProjectSettingsView project={p} />}
      </div>

      {/* Mounted on first open and kept afterwards so the sheet's close
          animation still plays. */}
      {detailPanelMounted ? (
        <TaskDetailPanel
          task={selectedTask}
          projectId={id}
          project={p}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </div>
  );
}

function ComingSoon({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-bg-subtle p-10 text-center">
      <div className="mx-auto mb-2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white text-ink-disabled">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>
    </div>
  );
}

