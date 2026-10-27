'use client';

import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  FolderKanban,
  Kanban,
  Layers,
  List,
  Sparkles,
  TrendingUp,
  UserCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { TaskPriority, TaskStatus, TaskWithPeople } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import {
  PriorityBadge,
  STATUS_OPTIONS,
  StatusBadge,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { UserAvatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { QueryError } from '@/components/ui/query-error';
import {
  matchesTaskOverviewFilters,
  useDashboardFilters,
  type DashboardGroupBy,
} from '@/hooks/use-dashboard-filters';
import { useDashboardOverviewTasks } from '@/hooks/use-dashboard-overview-tasks';
import { useUpdateTask } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';

export function WorkOverviewWidget() {
  const session = useSessionContext();
  const currentUserId = session.data?.user?.id ?? '';
  const filters = useDashboardFilters();
  const {
    workspaceId,
    status,
    priority,
    assigneeIds,
    duePreset,
    search,
    dateField,
    dateFrom,
    dateTo,
    groupBy,
    viewMode,
    setGroupBy,
    setViewMode,
    setDuePreset,
    setStatus,
    resetFilters,
  } = filters;

  const updateTask = useUpdateTask();

  // Tasks scoped to the filtered workspace or org-aggregated. Shared with
  // the DashboardFilterBar through the query cache.
  const tasksQuery = useDashboardOverviewTasks();

  const rawTasks = useMemo(() => tasksQuery.data?.items ?? [], [tasksQuery.data]);

  // Filter tasks client-side
  const filteredTasks = useMemo(() => {
    return rawTasks.filter((t) =>
      matchesTaskOverviewFilters(
        t,
        {
          workspaceId,
          status,
          priority,
          assigneeIds,
          duePreset,
          search,
          dateField,
          dateFrom,
          dateTo,
        },
        currentUserId,
      ),
    );
  }, [
    rawTasks,
    workspaceId,
    status,
    priority,
    assigneeIds,
    duePreset,
    search,
    dateField,
    dateFrom,
    dateTo,
    currentUserId,
  ]);

  // Overall metric counters from raw tasks
  const metrics = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayEnd = new Date().setHours(23, 59, 59, 999);

    let overdue = 0;
    let dueToday = 0;
    let inProgress = 0;
    let completed = 0;

    for (const t of rawTasks) {
      if (t.status === 'DONE') {
        completed++;
        continue;
      }
      if (t.status === 'CANCELLED') continue;

      if (t.status === 'IN_PROGRESS') inProgress++;

      if (t.dueDate) {
        const d = new Date(t.dueDate).getTime();
        if (d < todayStart) overdue++;
        else if (d >= todayStart && d <= todayEnd) dueToday++;
      }
    }

    return {
      // Server-side count of matching tasks, which can exceed the loaded page.
      total: tasksQuery.data?.pagination.total ?? rawTasks.length,
      loaded: rawTasks.length,
      filtered: filteredTasks.length,
      overdue,
      dueToday,
      inProgress,
      completed,
    };
  }, [rawTasks, filteredTasks, tasksQuery.data]);

  // Grouped tasks for grouped view
  const groupedTasks = useMemo(() => {
    if (groupBy === 'none') return null;

    const map = new Map<string, { title: string; tasks: TaskWithPeople[] }>();

    for (const t of filteredTasks) {
      let groupKey = 'Other';
      let groupTitle = 'Other';

      if (groupBy === 'status') {
        groupKey = t.status;
        groupTitle = statusLabel(t.status);
      } else if (groupBy === 'assignee') {
        if (!t.assignee) {
          groupKey = '__unassigned__';
          groupTitle = 'Unassigned';
        } else {
          groupKey = t.assignee.id;
          groupTitle = t.assignee.name || t.assignee.email;
        }
      } else if (groupBy === 'workspace') {
        const ws = t.project?.workspace;
        groupKey = ws?.id ?? '__unknown_ws__';
        groupTitle = ws?.name ?? 'General Workspace';
      } else if (groupBy === 'priority') {
        groupKey = t.priority;
        groupTitle = priorityLabel(t.priority);
      } else if (groupBy === 'dueDate') {
        if (!t.dueDate) {
          groupKey = 'no_date';
          groupTitle = 'No Due Date';
        } else {
          const d = new Date(t.dueDate).getTime();
          const todayStart = new Date().setHours(0, 0, 0, 0);
          const todayEnd = new Date().setHours(23, 59, 59, 999);
          const weekEnd = todayStart + 7 * 24 * 60 * 60 * 1000;

          if (d < todayStart && t.status !== 'DONE' && t.status !== 'CANCELLED') {
            groupKey = 'overdue';
            groupTitle = '⚠️ Overdue';
          } else if (d >= todayStart && d <= todayEnd) {
            groupKey = 'today';
            groupTitle = '⚡ Due Today';
          } else if (d <= weekEnd) {
            groupKey = 'this_week';
            groupTitle = '🗓️ Due This Week';
          } else {
            groupKey = 'later';
            groupTitle = 'Later';
          }
        }
      }

      if (!map.has(groupKey)) {
        map.set(groupKey, { title: groupTitle, tasks: [] });
      }
      map.get(groupKey)!.tasks.push(t);
    }

    return Array.from(map.entries()).map(([key, data]) => ({
      key,
      title: data.title,
      tasks: data.tasks,
    }));
  }, [filteredTasks, groupBy]);

  return (
    <div className="rounded-2xl border border-line bg-white shadow-soft">
      {/* Widget Header with Stat Cards & View Controls */}
      <div className="border-b border-line p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-purple">
                <Layers className="h-4 w-4" />
              </span>
              <h2 className="text-base font-semibold text-ink">
                Work Overview
              </h2>
              <span className="whitespace-nowrap rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">
                {filteredTasks.length} {filteredTasks.length === 1 ? 'task' : 'tasks'}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              Live multi-criteria overview across workspaces, assignees, and deadlines.
            </p>
            {metrics.total > metrics.loaded ? (
              <p className="mt-1 text-xs text-ink-muted">
                Showing the first {metrics.loaded} of {metrics.total} matching tasks. Narrow the
                filters to see the rest.
              </p>
            ) : null}
          </div>

          {/* View Mode & Group By Controls */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Group By selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
                Group:
              </span>
              <select
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as DashboardGroupBy)}
                className="h-8 rounded-lg border border-line bg-white px-2.5 text-xs text-ink shadow-sm focus:border-brand-purple focus:outline-none"
                aria-label="Group tasks by"
              >
                <option value="none">No grouping</option>
                <option value="status">By Status</option>
                <option value="assignee">By Assignee</option>
                <option value="workspace">By Workspace</option>
                <option value="dueDate">By Due Date</option>
                <option value="priority">By Priority</option>
              </select>
            </div>

            {/* View Mode Toggle: List vs Board */}
            <div className="flex rounded-lg border border-line p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                  viewMode === 'list'
                    ? 'bg-brand-50 text-brand-700 shadow-sm'
                    : 'text-ink-muted hover:text-ink',
                )}
                aria-label="List view"
              >
                <List className="h-3.5 w-3.5" />
                List
              </button>
              <button
                type="button"
                onClick={() => setViewMode('board')}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-all',
                  viewMode === 'board'
                    ? 'bg-brand-50 text-brand-700 shadow-sm'
                    : 'text-ink-muted hover:text-ink',
                )}
                aria-label="Cards view"
              >
                <Kanban className="h-3.5 w-3.5" />
                Cards
              </button>
            </div>
          </div>
        </div>

        {/* Quick KPI Stat Strips (Interactive quick-filter shortcuts!) */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          <StatShortcut
            label="Total Tasks"
            count={metrics.total}
            active={duePreset === 'all' && status.length === 0}
            onClick={resetFilters}
          />
          <StatShortcut
            label="Overdue"
            count={metrics.overdue}
            variant="error"
            active={duePreset === 'overdue'}
            onClick={() => setDuePreset('overdue')}
          />
          <StatShortcut
            label="Due Today"
            count={metrics.dueToday}
            variant="warning"
            active={duePreset === 'today'}
            onClick={() => setDuePreset('today')}
          />
          <StatShortcut
            label="In Progress"
            count={metrics.inProgress}
            variant="info"
            active={status.includes('IN_PROGRESS') && status.length === 1}
            onClick={() => setStatus(['IN_PROGRESS'])}
          />
          <StatShortcut
            label="Completed"
            count={metrics.completed}
            variant="success"
            active={status.includes('DONE') && status.length === 1}
            onClick={() => setStatus(['DONE'])}
          />
        </div>
      </div>

      {/* Main Content Area */}
      <div className="p-4 sm:p-5">
        {tasksQuery.isLoading ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2">
            <Loader size="md" />
            <p className="text-xs text-ink-muted">Loading tasks overview…</p>
          </div>
        ) : tasksQuery.isError ? (
          <QueryError onRetry={() => void tasksQuery.refetch()} />
        ) : filteredTasks.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-line p-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-50 text-brand-purple">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <h3 className="mt-3 text-sm font-medium text-ink">No matching tasks found</h3>
            <p className="mt-1 text-xs text-ink-muted">
              Try adjusting your workspace, assignee, status or date filters.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={resetFilters}
              className="mt-3.5 text-xs"
            >
              Reset all filters
            </Button>
          </div>
        ) : viewMode === 'list' ? (
          /* List / Table View */
          <div className="space-y-4">
            {groupedTasks ? (
              groupedTasks.map((grp) => (
                <div key={grp.key} className="space-y-2">
                  <div className="flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-muted">
                    <span>{grp.title}</span>
                    <span className="rounded-full bg-bg-subtle px-2 py-0.2 text-[10px] text-ink-muted">
                      {grp.tasks.length}
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-line bg-white">
                    <TaskTableRows tasks={grp.tasks} onUpdateStatus={handleUpdateStatus} />
                  </div>
                </div>
              ))
            ) : (
              <div className="overflow-hidden rounded-xl border border-line bg-white">
                <TaskTableRows tasks={filteredTasks} onUpdateStatus={handleUpdateStatus} />
              </div>
            )}
          </div>
        ) : (
          /* Cards / Board View */
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {groupedTasks ? (
              groupedTasks.map((grp) => (
                <div
                  key={grp.key}
                  className="flex flex-col rounded-xl border border-line bg-bg-subtle/40 p-3"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-semibold text-ink">{grp.title}</h3>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-ink-muted shadow-sm">
                      {grp.tasks.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {grp.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onUpdateStatus={handleUpdateStatus}
                      />
                    ))}
                  </div>
                </div>
              ))
            ) : (
              filteredTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onUpdateStatus={handleUpdateStatus}
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );

  function handleUpdateStatus(taskId: string, newStatus: TaskStatus) {
    updateTask.mutate({ id: taskId, input: { status: newStatus } });
  }
}

// -------------------------------------------------------------
// Interactive Table Rows Component
// -------------------------------------------------------------
function TaskTableRows({
  tasks,
  onUpdateStatus,
}: {
  tasks: TaskWithPeople[];
  onUpdateStatus: (taskId: string, status: TaskStatus) => void;
}) {
  return (
    <div className="divide-y divide-line/60 overflow-x-auto">
      {tasks.map((t) => {
        const due = t.dueDate ? new Date(t.dueDate) : null;
        const overdue = due
          ? due.getTime() < new Date().setHours(0, 0, 0, 0) &&
            t.status !== 'DONE' &&
            t.status !== 'CANCELLED'
          : false;
        const dueToday = due ? isSameDay(due, new Date()) : false;

        return (
          <div
            key={t.id}
            className="group flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-bg-subtle/70"
          >
            {/* Status changer & Title */}
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <StatusChanger
                status={t.status}
                onChange={(s) => onUpdateStatus(t.id, s)}
              />

              <div className="min-w-0 flex-1">
                <Link
                  href={`/projects/${t.projectId}`}
                  className="flex items-center gap-1.5 font-medium text-ink hover:text-brand-purple"
                >
                  <span className="truncate text-xs sm:text-sm">{t.title}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 text-ink-muted" />
                </Link>

                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                  {/* Workspace badge */}
                  {t.project?.workspace ? (
                    <span className="inline-flex items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.2 text-[10px] font-medium text-ink">
                      <Building2 className="h-2.5 w-2.5 text-ink-muted" />
                      {t.project.workspace.name}
                    </span>
                  ) : null}

                  {/* Project badge */}
                  {t.project ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-ink-muted">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: t.project.color ?? '#6366f1' }}
                      />
                      {t.project.name}
                    </span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Right Meta Badges: Priority, Due Date, Assignee */}
            <div className="flex shrink-0 items-center gap-3">
              <div className="hidden sm:block">
                <PriorityBadge priority={t.priority} />
              </div>

              {due ? (
                <span
                  className={cn(
                    'whitespace-nowrap inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs tabular-nums',
                    overdue
                      ? 'bg-state-error/10 font-semibold text-state-error'
                      : dueToday
                        ? 'bg-brand-orange/10 font-semibold text-brand-orange'
                        : 'text-ink-muted',
                  )}
                >
                  {overdue ? <AlertTriangle className="h-3 w-3 text-state-error" /> : null}
                  {formatDuePill(due)}
                </span>
              ) : (
                <span className="hidden text-xs text-ink-disabled sm:inline">
                  No date
                </span>
              )}

              {/* Assignee Avatar */}
              {t.assignee ? (
                <div
                  className="flex items-center gap-1.5"
                  title={t.assignee.name || t.assignee.email}
                >
                  <UserAvatar
                    size="xs"
                    name={t.assignee.name || t.assignee.email}
                    image={t.assignee.image}
                  />
                  <span className="hidden max-w-[100px] truncate text-xs text-ink sm:inline">
                    {t.assignee.name || t.assignee.email.split('@')[0]}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-ink-disabled">Unassigned</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------
// Interactive Status Changer Button
// -------------------------------------------------------------
function StatusChanger({
  status,
  onChange,
}: {
  status: TaskStatus;
  onChange: (s: TaskStatus) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1 transition-colors hover:bg-bg-subtle focus-visible:outline-none"
          title={`Status: ${statusLabel(status)}. Click to change.`}
        >
          {status === 'DONE' ? (
            <CheckCircle2 className="h-4 w-4 text-brand-teal" />
          ) : status === 'IN_PROGRESS' ? (
            <span className="relative flex h-3.5 w-3.5 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-purple opacity-40" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-purple" />
            </span>
          ) : (
            <Circle className="h-3.5 w-3.5 text-ink-disabled hover:text-ink" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44 p-1">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Change Status
        </div>
        <div className="space-y-0.5">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onChange(s);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center justify-between rounded px-2 py-1 text-xs transition-colors',
                status === s
                  ? 'bg-brand-50 font-medium text-brand-700'
                  : 'text-ink hover:bg-bg-subtle',
              )}
            >
              <span>{statusLabel(s)}</span>
              {status === s ? <Check className="h-3 w-3" /> : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Task Card Component (For Kanban/Grid View)
// -------------------------------------------------------------
function TaskCard({
  task,
  onUpdateStatus,
}: {
  task: TaskWithPeople;
  onUpdateStatus: (taskId: string, s: TaskStatus) => void;
}) {
  const due = task.dueDate ? new Date(task.dueDate) : null;
  const overdue = due
    ? due.getTime() < new Date().setHours(0, 0, 0, 0) &&
      task.status !== 'DONE' &&
      task.status !== 'CANCELLED'
    : false;

  return (
    <div className="group rounded-xl border border-line bg-white p-3.5 shadow-sm transition-all hover:border-brand-purple/30 hover:shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <StatusBadge status={task.status} />
        <PriorityBadge priority={task.priority} />
      </div>

      <Link
        href={`/projects/${task.projectId}`}
        className="mt-2 block font-medium text-ink hover:text-brand-purple"
      >
        <h4 className="line-clamp-2 text-xs font-semibold leading-relaxed">
          {task.title}
        </h4>
      </Link>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-muted">
        {task.project?.workspace ? (
          <span className="rounded bg-bg-subtle px-1.5 py-0.5 font-medium text-ink">
            {task.project.workspace.name}
          </span>
        ) : null}
        {task.project ? <span>• {task.project.name}</span> : null}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line/60 pt-2 text-xs">
        {due ? (
          <span
            className={cn(
              'inline-flex items-center gap-1 text-[11px] tabular-nums',
              overdue ? 'font-semibold text-state-error' : 'text-ink-muted',
            )}
          >
            {overdue ? <AlertTriangle className="h-3 w-3 text-state-error" /> : <Calendar className="h-3 w-3" />}
            {formatDuePill(due)}
          </span>
        ) : (
          <span className="text-[11px] text-ink-disabled">No due date</span>
        )}

        {task.assignee ? (
          <div
            className="flex items-center gap-1"
            title={task.assignee.name || task.assignee.email}
          >
            <UserAvatar
              size="xs"
              name={task.assignee.name || task.assignee.email}
              image={task.assignee.image}
            />
          </div>
        ) : (
          <span className="text-[11px] text-ink-disabled">Unassigned</span>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Stat Shortcut Card
// -------------------------------------------------------------
function StatShortcut({
  label,
  count,
  variant = 'default',
  active = false,
  onClick,
}: {
  label: string;
  count: number;
  variant?: 'default' | 'error' | 'warning' | 'info' | 'success';
  active?: boolean;
  onClick: () => void;
}) {
  const colorMap = {
    default: 'text-ink',
    error: 'text-state-error',
    warning: 'text-brand-orange',
    info: 'text-brand-purple',
    success: 'text-brand-teal',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start rounded-xl border p-2.5 text-left transition-all',
        active
          ? 'border-brand-purple/50 bg-brand-50/50 shadow-sm ring-1 ring-brand-purple/20'
          : 'border-line/70 bg-white hover:bg-bg-subtle hover:border-line',
      )}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <span className={cn('mt-0.5 text-lg font-bold tabular-nums', colorMap[variant])}>
        {count}
      </span>
    </button>
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatDuePill(d: Date): string {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round((d.getTime() - todayStart) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return `${Math.abs(diffDays)}d late`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays <= 7) return `In ${diffDays}d`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
