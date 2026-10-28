'use client';

import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { TaskDateField, TaskPriority, TaskStatus, TaskWithPeople } from '@botss/shared-types';

import {
  ASSIGNED_TO_ME_TOKEN,
  DEFAULT_DASHBOARD_FILTERS,
  UNASSIGNED_TOKEN,
  activeDayRange,
  matchesDayRange,
  type DashboardFilterValues,
  type DashboardGroupBy,
  type DashboardViewMode,
} from '@/lib/dashboard-filters';
import {
  dayRangeToInstants,
  formatDayRange,
  normalizeDayRange,
  type DayRange,
} from '@/lib/date-range';
import { matchesDuePreset, type DueDatePreset } from '@/lib/task-filters';

export type { DueDatePreset };

export type { DashboardGroupBy, DashboardViewMode, DashboardFilterValues };

export interface DashboardFilterState extends DashboardFilterValues {
  setWorkspaceId: (workspaceId: string | null) => void;
  setStatus: (status: TaskStatus[]) => void;
  toggleStatus: (status: TaskStatus) => void;
  setPriority: (priority: TaskPriority[]) => void;
  togglePriority: (priority: TaskPriority) => void;
  setAssigneeIds: (assigneeIds: string[]) => void;
  toggleAssigneeId: (assigneeId: string) => void;
  setDuePreset: (duePreset: DueDatePreset) => void;
  setSearch: (search: string) => void;
  setDateField: (dateField: TaskDateField) => void;
  /** null clears the range. */
  setDateRange: (range: DayRange | null) => void;
  setGroupBy: (groupBy: DashboardGroupBy) => void;
  setViewMode: (viewMode: DashboardViewMode) => void;
  /** Replace every value at once (URL hydration). */
  replaceAll: (values: DashboardFilterValues) => void;
  resetFilters: () => void;
}

export const useDashboardFilters = create<DashboardFilterState>((set) => ({
  ...DEFAULT_DASHBOARD_FILTERS,

  setWorkspaceId: (workspaceId) => set({ workspaceId }),
  setStatus: (status) => set({ status }),
  toggleStatus: (s) =>
    set((state) => ({
      status: state.status.includes(s) ? state.status.filter((x) => x !== s) : [...state.status, s],
    })),
  setPriority: (priority) => set({ priority }),
  togglePriority: (p) =>
    set((state) => ({
      priority: state.priority.includes(p)
        ? state.priority.filter((x) => x !== p)
        : [...state.priority, p],
    })),
  setAssigneeIds: (assigneeIds) => set({ assigneeIds }),
  toggleAssigneeId: (id) =>
    set((state) => ({
      assigneeIds: state.assigneeIds.includes(id)
        ? state.assigneeIds.filter((x) => x !== id)
        : [...state.assigneeIds, id],
    })),
  setDuePreset: (duePreset) => set({ duePreset }),
  setSearch: (search) => set({ search }),
  setDateField: (dateField) => set({ dateField }),
  setDateRange: (range) => set({ dateFrom: range?.from ?? null, dateTo: range?.to ?? null }),
  setGroupBy: (groupBy) => set({ groupBy }),
  setViewMode: (viewMode) => set({ viewMode }),
  replaceAll: (values) => set(values),
  // Layout choices (groupBy / viewMode) are not filters and survive Clear all.
  resetFilters: () =>
    set({
      workspaceId: DEFAULT_DASHBOARD_FILTERS.workspaceId,
      status: [],
      priority: [],
      assigneeIds: [],
      duePreset: 'all',
      search: '',
      dateField: DEFAULT_DASHBOARD_FILTERS.dateField,
      dateFrom: null,
      dateTo: null,
    }),
}));

/** The plain values of the store, without its actions. */
export function selectDashboardFilterValues(s: DashboardFilterState): DashboardFilterValues {
  return {
    workspaceId: s.workspaceId,
    status: s.status,
    priority: s.priority,
    assigneeIds: s.assigneeIds,
    duePreset: s.duePreset,
    search: s.search,
    dateField: s.dateField,
    dateFrom: s.dateFrom,
    dateTo: s.dateTo,
    groupBy: s.groupBy,
    viewMode: s.viewMode,
  };
}

/**
 * The dashboard's date range when one is fully set, else null. The range
 * widgets (completion chart, completed KPI, top performers, hours) read this;
 * they fall back to their own default window when it is null.
 */
export function useDashboardDayRange(): DayRange | null {
  const [from, to] = useDashboardFilters(useShallow((s) => [s.dateFrom, s.dateTo] as const));
  return useMemo(() => normalizeDayRange(from, to), [from, to]);
}

/**
 * The window the hours widgets sum: the dashboard's date range when set,
 * otherwise the current ISO week (Monday 00:00 local, seven days).
 */
export function useDashboardHoursWindow(): { from: Date; to: Date; rangeLabel: string | null } {
  const range = useDashboardDayRange();
  return useMemo(() => {
    if (range) return { ...dayRangeToInstants(range), rangeLabel: formatDayRange(range) };
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from, to, rangeLabel: null };
  }, [range]);
}

type FilterSubset = Pick<
  DashboardFilterValues,
  'workspaceId' | 'status' | 'priority' | 'assigneeIds' | 'duePreset' | 'search'
> &
  Partial<Pick<DashboardFilterValues, 'dateFrom' | 'dateTo'>>;

export function hasActiveDashboardFilters(filters: FilterSubset): boolean {
  return (
    activeDayRange({ dateFrom: filters.dateFrom ?? null, dateTo: filters.dateTo ?? null }) !==
      null ||
    filters.workspaceId !== null ||
    filters.status.length > 0 ||
    filters.priority.length > 0 ||
    filters.assigneeIds.length > 0 ||
    filters.duePreset !== 'all' ||
    filters.search.trim().length > 0
  );
}

export function activeDashboardFilterCount(filters: FilterSubset): number {
  let count = 0;
  if (activeDayRange({ dateFrom: filters.dateFrom ?? null, dateTo: filters.dateTo ?? null }))
    count++;
  if (filters.workspaceId !== null) count++;
  if (filters.status.length > 0) count += filters.status.length;
  if (filters.priority.length > 0) count += filters.priority.length;
  if (filters.assigneeIds.length > 0) count += filters.assigneeIds.length;
  if (filters.duePreset !== 'all') count++;
  if (filters.search.trim().length > 0) count++;
  return count;
}

/**
 * Client-side pass over the overview tasks. The server already applies every
 * filter except free-text search (see `dashboardTaskListQuery`), so this is
 * what applies search - which also matches project and assignee names - and
 * a cheap re-check of the rest against what was loaded.
 */
export function matchesTaskOverviewFilters(
  t: TaskWithPeople,
  filters: {
    workspaceId: string | null;
    status: TaskStatus[];
    priority: TaskPriority[];
    assigneeIds: string[];
    duePreset: DueDatePreset;
    search: string;
    dateField?: TaskDateField;
    dateFrom?: string | null;
    dateTo?: string | null;
  },
  currentUserId?: string,
): boolean {
  // 0. Date range on the chosen date (same rule as the API)
  const range = activeDayRange({
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
  });
  if (range && !matchesDayRange(t, filters.dateField ?? 'due', range)) return false;

  // 1. Workspace filter
  if (filters.workspaceId) {
    const wsId = t.project?.workspace?.id;
    if (wsId && wsId !== filters.workspaceId) return false;
  }

  // 2. Status filter
  if (filters.status.length > 0 && !filters.status.includes(t.status)) {
    return false;
  }

  // 3. Priority filter
  if (filters.priority.length > 0 && !filters.priority.includes(t.priority)) {
    return false;
  }

  // 4. Assignee filter (supports single or multiple, plus unassigned and assigned to me)
  if (filters.assigneeIds.length > 0) {
    const matched = filters.assigneeIds.some((id) => {
      if (id === UNASSIGNED_TOKEN) return !t.assigneeId;
      if (id === ASSIGNED_TO_ME_TOKEN && currentUserId) return t.assigneeId === currentUserId;
      return t.assigneeId === id;
    });
    if (!matched) return false;
  }

  // 5. Due date filter
  if (!matchesDuePreset(t, filters.duePreset)) return false;

  // 6. Search filter
  if (filters.search.trim()) {
    const needle = filters.search.trim().toLowerCase();
    const titleMatch = t.title.toLowerCase().includes(needle);
    const projectMatch = t.project?.name.toLowerCase().includes(needle) || false;
    const assigneeMatch =
      t.assignee?.name?.toLowerCase().includes(needle) ||
      t.assignee?.email.toLowerCase().includes(needle) ||
      false;
    if (!titleMatch && !projectMatch && !assigneeMatch) return false;
  }

  return true;
}
