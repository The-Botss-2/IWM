'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { TaskStatus, TaskWithPeople, TodoWithRefs } from '@botss/shared-types';

import { useDashboardDayRange, useDashboardFilters } from '@/hooks/use-dashboard-filters';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import {
  dayRangeLength,
  dayRangeToInstants,
  formatDayRange,
  parseYmd,
  previousDayRange,
  type DayRange,
} from '@/lib/date-range';

type TaskList = Awaited<ReturnType<ReturnType<typeof getApi>['tasks']['list']>>;

export const STATUS_ORDER: TaskStatus[] = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
  'CANCELLED',
];

const WORKLOAD_ROW_LIMIT = 8;

export interface StatusCount {
  status: TaskStatus;
  value: number;
}

export interface WorkloadRow {
  userId: string | null;
  name: string;
  image: string | null;
  open: number;
  overdue: number;
}

/** Non-zero status counts in board order, plus their sum. */
export function countByStatus(items: TaskWithPeople[]) {
  const counts = new Map<TaskStatus, number>();
  for (const s of STATUS_ORDER) counts.set(s, 0);
  for (const t of items) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const rows: StatusCount[] = STATUS_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    status: s,
    value: counts.get(s) ?? 0,
  }));
  const total = rows.reduce((a, r) => a + r.value, 0);
  return { rows, total };
}

/**
 * Open (not DONE / CANCELLED) task count per assignee, heaviest first.
 * Unassigned tasks bucket under their own row. `openTotal` and `groupCount`
 * are taken before the row limit so the widget can say what it cut.
 */
export function buildWorkload(items: TaskWithPeople[], now: number) {
  const open = items.filter((t) => t.status !== 'DONE' && t.status !== 'CANCELLED');
  const map = new Map<string, WorkloadRow>();
  for (const t of open) {
    const key = t.assignee?.id ?? '__unassigned__';
    const existing =
      map.get(key) ??
      ({
        userId: t.assignee?.id ?? null,
        name: t.assignee?.name ?? t.assignee?.email ?? 'Unassigned',
        image: t.assignee?.image ?? null,
        open: 0,
        overdue: 0,
      } satisfies WorkloadRow);
    existing.open += 1;
    if (t.dueDate && new Date(t.dueDate).getTime() < now) existing.overdue += 1;
    map.set(key, existing);
  }
  const all = [...map.values()].sort((a, b) => b.open - a.open);
  return {
    rows: all.slice(0, WORKLOAD_ROW_LIMIT),
    openTotal: open.length,
    groupCount: all.length,
  };
}

const selectStatusCounts = (data: TaskList) => countByStatus(data.items);
const selectWorkload = (data: TaskList) => buildWorkload(data.items, Date.now());

/**
 * One workspace-wide task fetch shared by the status donut and the workload
 * widget; each derives its own view through `select`.
 */
function useWorkspaceTaskSnapshot<T>(select: (data: TaskList) => T) {
  const ws = useCurrentWorkspace();
  const { workspaceId } = useDashboardFilters();
  const effectiveWsId = workspaceId ?? ws.data?.id ?? 'org';
  return useQuery({
    queryKey: ['ws-task-snapshot', effectiveWsId],
    queryFn: () =>
      getApi().tasks.list({
        pageSize: 1000,
        sort: 'updatedAt',
        order: 'desc',
        ...(workspaceId ? { workspaceId } : { aggregate: 'org' }),
      }),
    staleTime: 60_000,
    select,
  });
}

export function useTaskStatusCounts() {
  return useWorkspaceTaskSnapshot(selectStatusCounts);
}

export function useWorkload() {
  return useWorkspaceTaskSnapshot(selectWorkload);
}

// ---- Completed work (KPI strip, weekly completion chart, top performers) --

/**
 * Shared source for the workspace dashboard's "completed work" widgets
 * (KPI strip, weekly completion chart, top performers). They used to fire
 * three separate `status=DONE` task lists with different page sizes; now
 * they all read one cached query and derive their numbers via the pure
 * selectors below.
 */

/** Largest page any consumer needs - covers the 8-week completion chart. */
const DONE_TASKS_PAGE_SIZE = 1000;

const workspaceDoneTasksKey = (wsId: string, range: DayRange | null = null) =>
  ['ws-done-tasks', wsId, range ? `${range.from}..${range.to}` : 'default'] as const;
const workspaceDoneTodosKey = (wsId: string) => ['ws-completion', 'todos', wsId] as const;

/** Server-side filter for DONE tasks completed inside `range`. */
function completedInRangeQuery(range: DayRange) {
  const { from, to } = dayRangeToInstants(range);
  return { status: 'DONE' as const, dateField: 'completed' as const, from, to };
}

/**
 * Done tasks for the completed-work chart and top performers. With a
 * dashboard date range the API narrows to tasks completed in that range;
 * without one, the latest `DONE_TASKS_PAGE_SIZE` done tasks cover the default
 * 8-week window.
 */
export function useWorkspaceDoneTasks(
  range: DayRange | null = null,
  options: { enabled?: boolean } = {},
) {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  return useQuery({
    queryKey: workspaceDoneTasksKey(wsId, range),
    queryFn: () =>
      getApi().tasks.list({
        status: 'DONE',
        sort: 'updatedAt',
        order: 'desc',
        pageSize: DONE_TASKS_PAGE_SIZE,
        ...(range ? completedInRangeQuery(range) : {}),
      }),
    enabled: !!wsId && (options.enabled ?? true),
    staleTime: 60_000,
  });
}

/**
 * Whether a range-mode done-tasks page holds fewer rows than match, i.e. the
 * derived chart / ranking are partial. Not reported for the default window:
 * there the page is "latest done tasks ever", whose total always exceeds it.
 */
function isTruncated(data: TaskList | undefined, range: DayRange | null): boolean {
  return !!range && !!data && data.pagination.total > data.items.length;
}

/**
 * Exact count of tasks completed inside `range`, from the server's total
 * (one row fetched), so the KPI never undercounts a long range.
 */
function useCompletedCount(range: DayRange | null) {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  return useQuery({
    queryKey: ['ws-done-tasks', wsId, 'count', range ? `${range.from}..${range.to}` : 'none'],
    queryFn: () =>
      getApi()
        .tasks.list({ ...completedInRangeQuery(range!), pageSize: 1 })
        .then((r) => r.pagination.total),
    enabled: !!wsId && !!range,
    staleTime: 60_000,
  });
}

function useWorkspaceDoneTodos() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  return useQuery({
    queryKey: workspaceDoneTodosKey(wsId),
    queryFn: () => getApi().todos.list({ done: true, limit: 1000 }),
    enabled: !!wsId,
    staleTime: 60_000,
  });
}

// ---- Pure selectors ------------------------------------------------------

export function startOfIsoWeek(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday-anchored.
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}

function completedAtMs(t: Pick<TaskWithPeople, 'completedAt' | 'updatedAt'>): number | null {
  const when = t.completedAt ?? t.updatedAt;
  return when ? new Date(when).getTime() : null;
}

export interface WeekBucket {
  label: string;
  weekStart: number;
  tasks: number;
  todos: number;
}

function weekLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Tasks + todos completed per ISO week, oldest first, `weeksBack` buckets. */
export function bucketCompletionsByWeek(
  tasks: readonly TaskWithPeople[],
  todos: readonly TodoWithRefs[],
  weeksBack: number,
  now: Date = new Date(),
): WeekBucket[] {
  const buckets: WeekBucket[] = [];
  const thisStart = startOfIsoWeek(now);
  for (let i = weeksBack - 1; i >= 0; i--) {
    const start = new Date(thisStart);
    start.setDate(start.getDate() - i * 7);
    buckets.push({ label: weekLabel(start), weekStart: start.getTime(), tasks: 0, todos: 0 });
  }
  const findBucket = (ts: number): WeekBucket | undefined => {
    // Buckets are in ascending order; reverse-scan finds the latest one
    // whose start <= ts in O(weeksBack).
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i]!;
      if (ts >= b.weekStart) return b;
    }
    return undefined;
  };
  for (const t of tasks) {
    const ts = completedAtMs(t);
    if (ts == null) continue;
    const b = findBucket(ts);
    if (b) b.tasks++;
  }
  for (const t of todos) {
    // Todo uses `doneAt`; fall back to `updatedAt` for rows completed
    // before the column was tracked.
    const when = t.doneAt ?? t.updatedAt;
    if (!when) continue;
    const b = findBucket(new Date(when).getTime());
    if (b) b.todos++;
  }
  return buckets;
}

/** Tasks completed in the current and the previous ISO week. */
export function countCompletedThisAndPrevWeek(
  tasks: readonly TaskWithPeople[],
  now: Date = new Date(),
): { thisWeek: number; prevWeek: number } {
  const startThis = startOfIsoWeek(now);
  const startPrev = new Date(startThis);
  startPrev.setDate(startPrev.getDate() - 7);
  const endThis = new Date(startThis);
  endThis.setDate(endThis.getDate() + 7);
  let a = 0;
  let b = 0;
  for (const t of tasks) {
    const ts = completedAtMs(t);
    if (ts == null) continue;
    if (ts >= startThis.getTime() && ts < endThis.getTime()) a++;
    else if (ts >= startPrev.getTime() && ts < startThis.getTime()) b++;
  }
  return { thisWeek: a, prevWeek: b };
}

export interface PerformerRow {
  userId: string;
  name: string;
  image: string | null;
  count: number;
}

/** Half-open [start, end) window in epoch ms. */
export interface TimeWindow {
  start: number;
  end: number;
}

export function dayRangeWindow(range: DayRange): TimeWindow {
  const { from, to } = dayRangeToInstants(range);
  return { start: from.getTime(), end: to.getTime() + 1 };
}

function isoWeekWindow(now: Date): TimeWindow {
  const start = startOfIsoWeek(now);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

export type CompletionGranularity = 'day' | 'week' | 'month';

/** Days up to a month, weeks up to ~half a year, months beyond. */
export function granularityFor(range: DayRange): CompletionGranularity {
  const days = dayRangeLength(range);
  if (days <= 31) return 'day';
  if (days <= 26 * 7) return 'week';
  return 'month';
}

/**
 * Tasks + todos completed inside `range`, bucketed by day, ISO week or month
 * (see `granularityFor`). The first bucket starts at the range start and the
 * rest snap to whole weeks / months, so nothing outside the range counts.
 */
export function bucketCompletionsInRange(
  tasks: readonly TaskWithPeople[],
  todos: readonly TodoWithRefs[],
  range: DayRange,
): WeekBucket[] {
  const granularity = granularityFor(range);
  const window = dayRangeWindow(range);
  const buckets: WeekBucket[] = [];
  let cursor = parseYmd(range.from)!;
  while (cursor.getTime() < window.end) {
    const label =
      granularity === 'month'
        ? cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' })
        : weekLabel(cursor);
    buckets.push({ label, weekStart: cursor.getTime(), tasks: 0, todos: 0 });
    const next = new Date(cursor);
    if (granularity === 'day') next.setDate(next.getDate() + 1);
    else if (granularity === 'week') next.setDate(next.getDate() + 7 - ((next.getDay() + 6) % 7));
    else next.setMonth(next.getMonth() + 1, 1);
    cursor = next;
  }
  const findBucket = (ts: number): WeekBucket | undefined => {
    if (ts < window.start || ts >= window.end) return undefined;
    for (let i = buckets.length - 1; i >= 0; i--) {
      const b = buckets[i]!;
      if (ts >= b.weekStart) return b;
    }
    return undefined;
  };
  for (const t of tasks) {
    const ts = completedAtMs(t);
    if (ts == null) continue;
    const b = findBucket(ts);
    if (b) b.tasks++;
  }
  for (const t of todos) {
    const when = t.doneAt ?? t.updatedAt;
    if (!when) continue;
    const b = findBucket(new Date(when).getTime());
    if (b) b.todos++;
  }
  return buckets;
}

/** Assignees ranked by tasks completed in `window` (default: the current ISO week). */
export function rankTopPerformers(
  tasks: readonly TaskWithPeople[],
  limit: number,
  now: Date = new Date(),
  window: TimeWindow = isoWeekWindow(now),
): PerformerRow[] {
  const map = new Map<string, PerformerRow>();
  for (const t of tasks) {
    const ts = completedAtMs(t);
    if (ts == null) continue;
    if (ts < window.start || ts >= window.end) continue;
    if (!t.assignee) continue;
    const id = t.assignee.id;
    const existing = map.get(id) ?? {
      userId: id,
      name: t.assignee.name || t.assignee.email,
      image: t.assignee.image,
      count: 0,
    };
    existing.count += 1;
    map.set(id, existing);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export interface CountDelta {
  direction: 'up' | 'down' | 'flat';
  label: string;
}

/** Period-over-period delta for a KPI tile. */
export function computeDelta(current: number, prev: number): CountDelta | undefined {
  if (current === 0 && prev === 0) return undefined;
  if (prev === 0) return { direction: 'up', label: 'new' };
  const diff = current - prev;
  if (diff === 0) return { direction: 'flat', label: '0%' };
  const pct = Math.round((diff / prev) * 100);
  return {
    direction: diff > 0 ? 'up' : 'down',
    label: `${pct > 0 ? '+' : ''}${pct}%`,
  };
}

// ---- Derived hooks -------------------------------------------------------

/**
 * Completion chart data: the last `weeksBack` ISO weeks, or - when the
 * dashboard has a date range - the range in day / week / month buckets.
 */
export function useWeeklyCompletion(weeksBack: number) {
  const range = useDashboardDayRange();
  const tasksQ = useWorkspaceDoneTasks(range);
  const todosQ = useWorkspaceDoneTodos();
  const data = useMemo(
    () =>
      range
        ? bucketCompletionsInRange(tasksQ.data?.items ?? [], todosQ.data?.items ?? [], range)
        : bucketCompletionsByWeek(tasksQ.data?.items ?? [], todosQ.data?.items ?? [], weeksBack),
    [tasksQ.data, todosQ.data, weeksBack, range],
  );
  return {
    data,
    isLoading: tasksQ.isLoading || todosQ.isLoading,
    /** A source failed before any data arrived (the widget shows an error). */
    isError: (tasksQ.isError && !tasksQ.data) || (todosQ.isError && !todosQ.data),
    refetch: () => {
      void tasksQ.refetch();
      void todosQ.refetch();
    },
    granularity: range ? granularityFor(range) : ('week' as CompletionGranularity),
    rangeLabel: range ? formatDayRange(range) : null,
    /** Range mode only: more tasks completed in the range than were loaded. */
    truncated: isTruncated(tasksQ.data, range),
  };
}

/**
 * Completed-tasks KPI: this ISO week vs the previous one, or - with a
 * dashboard date range - the range vs the equally long period before it.
 * Range counts come from the server's totals, so they are exact for any
 * range length.
 */
export function useCompletedThisWeek() {
  const range = useDashboardDayRange();
  const listQ = useWorkspaceDoneTasks(null, { enabled: !range });
  const currentQ = useCompletedCount(range);
  const prevQ = useCompletedCount(range ? previousDayRange(range) : null);
  const counts = useMemo(() => {
    if (!range) return countCompletedThisAndPrevWeek(listQ.data?.items ?? []);
    return { thisWeek: currentQ.data ?? 0, prevWeek: prevQ.data ?? 0 };
  }, [range, listQ.data, currentQ.data, prevQ.data]);
  return {
    ...counts,
    delta: computeDelta(counts.thisWeek, counts.prevWeek),
    isLoading: range ? currentQ.isLoading || prevQ.isLoading : listQ.isLoading,
    isError: range
      ? (currentQ.isError && currentQ.data === undefined) ||
        (prevQ.isError && prevQ.data === undefined)
      : listQ.isError && !listQ.data,
    refetch: () => {
      if (range) {
        void currentQ.refetch();
        void prevQ.refetch();
      } else {
        void listQ.refetch();
      }
    },
    rangeLabel: range ? formatDayRange(range) : null,
  };
}

/** Top performers this ISO week, or inside the dashboard date range. */
export function useTopPerformers(limit = 5) {
  const range = useDashboardDayRange();
  const q = useWorkspaceDoneTasks(range);
  const rows = useMemo(
    () =>
      rankTopPerformers(
        q.data?.items ?? [],
        limit,
        new Date(),
        range ? dayRangeWindow(range) : undefined,
      ),
    [q.data, limit, range],
  );
  return {
    rows,
    isLoading: q.isLoading,
    isError: q.isError && !q.data,
    refetch: () => void q.refetch(),
    rangeLabel: range ? formatDayRange(range) : null,
    truncated: isTruncated(q.data, range),
  };
}
