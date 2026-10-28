/**
 * Pure helpers behind the dashboard filter bar: the filter values, how they
 * round-trip through the page URL, and how they become a `GET /tasks` query.
 * The Zustand store (hooks/use-dashboard-filters) holds the values; nothing
 * here touches React.
 */
import {
  TaskDateField,
  TaskPriority,
  TaskStatus,
  type ListTasksQuery,
  type TaskWithPeople,
} from '@botss/shared-types';

import { dayRangeToInstants, normalizeDayRange, type DayRange } from '@/lib/date-range';
import { DUE_DATE_PRESETS, type DueDatePreset } from '@/lib/task-filters';

export type DashboardGroupBy =
  | 'none'
  | 'status'
  | 'assignee'
  | 'workspace'
  | 'dueDate'
  | 'priority';
export type DashboardViewMode = 'list' | 'board';

const GROUP_BY: readonly DashboardGroupBy[] = [
  'none',
  'status',
  'assignee',
  'workspace',
  'dueDate',
  'priority',
];
const VIEW_MODES: readonly DashboardViewMode[] = ['list', 'board'];

/** Assignee multi-select tokens that are not user ids. */
export const UNASSIGNED_TOKEN = '__unassigned__';
export const ASSIGNED_TO_ME_TOKEN = '__assigned_to_me__';

export interface DashboardFilterValues {
  /** null = all workspaces (org aggregate). */
  workspaceId: string | null;
  status: TaskStatus[];
  priority: TaskPriority[];
  /** User ids plus the two tokens above. */
  assigneeIds: string[];
  duePreset: DueDatePreset;
  search: string;
  /** Which task date `dateFrom`/`dateTo` filter on. */
  dateField: TaskDateField;
  /** Inclusive local day, `yyyy-mm-dd`. Active only when both ends are set. */
  dateFrom: string | null;
  dateTo: string | null;
  groupBy: DashboardGroupBy;
  viewMode: DashboardViewMode;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilterValues = {
  workspaceId: null,
  status: [],
  priority: [],
  assigneeIds: [],
  duePreset: 'all',
  search: '',
  dateField: 'due',
  dateFrom: null,
  dateTo: null,
  groupBy: 'none',
  viewMode: 'list',
};

/** The active date range, or null when unset / half-set / malformed. */
export function activeDayRange(
  f: Pick<DashboardFilterValues, 'dateFrom' | 'dateTo'>,
): DayRange | null {
  return normalizeDayRange(f.dateFrom, f.dateTo);
}

/**
 * Client mirror of the API's `dateField` + `from`/`to` rule (see
 * apps/api/src/tasks/task-list-filters.ts), used to re-check rows the cache
 * changed optimistically. `completed` uses `completedAt`, else `updatedAt`
 * for a DONE task completed before `completedAt` was stamped.
 */
export function matchesDayRange(
  t: Pick<TaskWithPeople, 'dueDate' | 'createdAt' | 'completedAt' | 'updatedAt' | 'status'>,
  field: TaskDateField,
  range: DayRange,
): boolean {
  let when: Date | string | null | undefined;
  if (field === 'due') when = t.dueDate;
  else if (field === 'created') when = t.createdAt;
  else when = t.completedAt ?? (t.status === 'DONE' ? t.updatedAt : null);
  if (!when) return false;
  const ts = new Date(when).getTime();
  const { from, to } = dayRangeToInstants(range);
  return ts >= from.getTime() && ts <= to.getTime();
}

// ---- URL ------------------------------------------------------------------

/**
 * Query-string names. Short on purpose: these end up in links people paste.
 * Lists are comma-separated; assignee tokens are `me` and `unassigned`.
 */
export const DASHBOARD_URL_PARAMS = {
  workspace: 'ws',
  search: 'q',
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  due: 'due',
  dateField: 'dateField',
  from: 'from',
  to: 'to',
  groupBy: 'group',
  view: 'view',
} as const;

const URL_KEYS: readonly string[] = Object.values(DASHBOARD_URL_PARAMS);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function csv(sp: URLSearchParams, key: string): string[] {
  const raw = sp.get(key);
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function pick<T extends string>(allowed: readonly T[], value: string | null): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Whether the URL carries any dashboard filter param. */
export function hasDashboardUrlParams(sp: URLSearchParams): boolean {
  return URL_KEYS.some((k) => sp.has(k));
}

/**
 * Filter values from a URL. Unknown or malformed values are dropped (a stale
 * or hand-edited link degrades to "no filter", never to an error); anything
 * not in the URL takes its default.
 */
export function parseDashboardUrl(sp: URLSearchParams): DashboardFilterValues {
  const P = DASHBOARD_URL_PARAMS;
  const ws = sp.get(P.workspace);
  const assigneeIds = csv(sp, P.assignee)
    .map((v) => (v === 'me' ? ASSIGNED_TO_ME_TOKEN : v === 'unassigned' ? UNASSIGNED_TOKEN : v))
    .filter((v) => v === ASSIGNED_TO_ME_TOKEN || v === UNASSIGNED_TOKEN || ID_RE.test(v));
  const range = normalizeDayRange(sp.get(P.from), sp.get(P.to));
  return {
    workspaceId: ws && ID_RE.test(ws) ? ws : null,
    search: sp.get(P.search) ?? '',
    status: csv(sp, P.status).filter((s): s is TaskStatus => TaskStatus.safeParse(s).success),
    priority: csv(sp, P.priority).filter(
      (p): p is TaskPriority => TaskPriority.safeParse(p).success,
    ),
    assigneeIds,
    duePreset: pick(DUE_DATE_PRESETS, sp.get(P.due)) ?? 'all',
    dateField: pick(TaskDateField.options, sp.get(P.dateField)) ?? 'due',
    dateFrom: range?.from ?? null,
    dateTo: range?.to ?? null,
    groupBy: pick(GROUP_BY, sp.get(P.groupBy)) ?? 'none',
    viewMode: pick(VIEW_MODES, sp.get(P.view)) ?? 'list',
  };
}

/**
 * The query string for `values`, keeping any non-dashboard params already in
 * `current`. Defaults are omitted so an unfiltered dashboard has a clean URL.
 */
export function serializeDashboardUrl(
  values: DashboardFilterValues,
  current: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const P = DASHBOARD_URL_PARAMS;
  const out = new URLSearchParams();
  current.forEach((v, k) => {
    if (!URL_KEYS.includes(k)) out.append(k, v);
  });
  if (values.workspaceId) out.set(P.workspace, values.workspaceId);
  if (values.search.trim()) out.set(P.search, values.search);
  if (values.status.length) out.set(P.status, values.status.join(','));
  if (values.priority.length) out.set(P.priority, values.priority.join(','));
  if (values.assigneeIds.length) {
    out.set(
      P.assignee,
      values.assigneeIds
        .map((id) =>
          id === ASSIGNED_TO_ME_TOKEN ? 'me' : id === UNASSIGNED_TOKEN ? 'unassigned' : id,
        )
        .join(','),
    );
  }
  if (values.duePreset !== 'all') out.set(P.due, values.duePreset);
  const range = activeDayRange(values);
  if (range) {
    if (values.dateField !== 'due') out.set(P.dateField, values.dateField);
    out.set(P.from, range.from);
    out.set(P.to, range.to);
  }
  if (values.groupBy !== 'none') out.set(P.groupBy, values.groupBy);
  if (values.viewMode !== 'list') out.set(P.view, values.viewMode);
  return out;
}

// ---- Task list query ------------------------------------------------------

const OPEN_STATUSES: readonly TaskStatus[] = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW'];
const DAY_MS = 86_400_000;

/**
 * Server-side bounds for a due preset, mirroring `matchesDuePreset` (local
 * days). `overdue` also narrows status to open tasks.
 */
function duePresetQuery(
  preset: DueDatePreset,
  status: TaskStatus[],
  now: Date,
): Partial<Pick<ListTasksQuery, 'dueAfter' | 'dueBefore' | 'noDueDate' | 'status'>> {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = todayStart + DAY_MS - 1;
  switch (preset) {
    case 'all':
      return {};
    case 'no_date':
      return { noDueDate: true };
    case 'overdue': {
      const open = status.length
        ? status.filter((s) => OPEN_STATUSES.includes(s))
        : [...OPEN_STATUSES];
      // Every picked status is closed: keep them, so the result is empty
      // rather than silently widening to all open tasks.
      return { dueBefore: new Date(todayStart - 1), status: open.length ? open : status };
    }
    case 'today':
      return { dueAfter: new Date(todayStart), dueBefore: new Date(todayEnd) };
    case 'tomorrow':
      return { dueAfter: new Date(todayEnd + 1), dueBefore: new Date(todayEnd + DAY_MS) };
    case 'this_week':
      return { dueAfter: new Date(todayStart), dueBefore: new Date(todayStart + 7 * DAY_MS) };
    case 'next_14_days':
      return { dueAfter: new Date(todayStart), dueBefore: new Date(todayStart + 14 * DAY_MS) };
  }
}

/**
 * The `GET /tasks` filters for the dashboard's values. Free-text search stays
 * client-side: it also matches project and assignee names, which the API's
 * title/description search does not.
 */
export function dashboardTaskListQuery(
  f: DashboardFilterValues,
  currentUserId: string,
  now: Date = new Date(),
): Partial<ListTasksQuery> {
  const q: Partial<ListTasksQuery> = f.workspaceId
    ? { workspaceId: f.workspaceId }
    : { aggregate: 'org' };
  if (f.status.length) q.status = f.status;
  if (f.priority.length) q.priority = f.priority;

  const ids = new Set<string>();
  for (const id of f.assigneeIds) {
    if (id === UNASSIGNED_TOKEN) q.unassigned = true;
    else if (id === ASSIGNED_TO_ME_TOKEN) {
      if (currentUserId) ids.add(currentUserId);
    } else ids.add(id);
  }
  if (ids.size) q.assigneeIds = [...ids].sort();

  Object.assign(q, duePresetQuery(f.duePreset, f.status, now));

  const range = activeDayRange(f);
  if (range) {
    const { from, to } = dayRangeToInstants(range);
    q.dateField = f.dateField;
    q.from = from;
    q.to = to;
  }
  return q;
}
