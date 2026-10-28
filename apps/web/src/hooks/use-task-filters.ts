'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { TaskPriority, TaskStatus, TaskWithPeople } from '@botss/shared-types';

import { PRIORITY_OPTIONS, STATUS_OPTIONS } from '@/components/tasks/task-badges';

import { DUE_DATE_PRESETS, matchesDuePreset, type DueDatePreset } from '@/lib/task-filters';

export type { DueDatePreset };

export interface TaskFilters {
  search: string;
  status: TaskStatus[];
  priority: TaskPriority[];
  assigneeIds: string[];
  dueDate: DueDatePreset;
}

const STATUS_SET = new Set<TaskStatus>(STATUS_OPTIONS);
const PRIORITY_SET = new Set<TaskPriority>(PRIORITY_OPTIONS);
const DUE_PRESETS: Set<DueDatePreset> = new Set(DUE_DATE_PRESETS);

function readArray<T extends string>(
  params: URLSearchParams,
  key: string,
  validate: (raw: string) => raw is T,
): T[] {
  const raw = params.getAll(key);
  return raw.filter(validate);
}

/**
 * URL-backed filter state shared between Board and List. Setters replace the
 * router state so the back button rewinds the user out of the project view
 * rather than through every filter change.
 */
export function useTaskFilters() {
  const router = useRouter();
  const params = useSearchParams();

  const rawDue = params.get('due') as DueDatePreset | null;
  const validDue: DueDatePreset = rawDue && DUE_PRESETS.has(rawDue) ? rawDue : 'all';

  const filters: TaskFilters = useMemo(
    () => ({
      search: params.get('q') ?? '',
      status: readArray<TaskStatus>(
        params as unknown as URLSearchParams,
        'status',
        (v): v is TaskStatus => STATUS_SET.has(v as TaskStatus),
      ),
      priority: readArray<TaskPriority>(
        params as unknown as URLSearchParams,
        'priority',
        (v): v is TaskPriority => PRIORITY_SET.has(v as TaskPriority),
      ),
      assigneeIds: params.getAll('assignee'),
      dueDate: validDue,
    }),
    [params, validDue],
  );

  const updateUrl = useCallback(
    (mutate: (sp: URLSearchParams) => void) => {
      const sp = new URLSearchParams(params.toString());
      mutate(sp);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [params, router],
  );

  const setSearch = useCallback(
    (v: string) => {
      updateUrl((sp) => {
        if (v) sp.set('q', v);
        else sp.delete('q');
      });
    },
    [updateUrl],
  );

  const setStatus = useCallback(
    (v: TaskStatus[]) => {
      updateUrl((sp) => {
        sp.delete('status');
        for (const s of v) sp.append('status', s);
      });
    },
    [updateUrl],
  );

  const setPriority = useCallback(
    (v: TaskPriority[]) => {
      updateUrl((sp) => {
        sp.delete('priority');
        for (const p of v) sp.append('priority', p);
      });
    },
    [updateUrl],
  );

  const setAssigneeIds = useCallback(
    (v: string[]) => {
      updateUrl((sp) => {
        sp.delete('assignee');
        for (const a of v) sp.append('assignee', a);
      });
    },
    [updateUrl],
  );

  const setDueDate = useCallback(
    (v: DueDatePreset) => {
      updateUrl((sp) => {
        if (v && v !== 'all') sp.set('due', v);
        else sp.delete('due');
      });
    },
    [updateUrl],
  );

  const setAll = useCallback(
    (next: TaskFilters) => {
      updateUrl((sp) => {
        if (next.search) sp.set('q', next.search);
        else sp.delete('q');
        sp.delete('status');
        for (const s of next.status) sp.append('status', s);
        sp.delete('priority');
        for (const p of next.priority) sp.append('priority', p);
        sp.delete('assignee');
        for (const a of next.assigneeIds) sp.append('assignee', a);
        if (next.dueDate && next.dueDate !== 'all') sp.set('due', next.dueDate);
        else sp.delete('due');
      });
    },
    [updateUrl],
  );

  const clearAll = useCallback(() => {
    updateUrl((sp) => {
      sp.delete('q');
      sp.delete('status');
      sp.delete('priority');
      sp.delete('assignee');
      sp.delete('due');
    });
  }, [updateUrl]);

  return {
    filters,
    setSearch,
    setStatus,
    setPriority,
    setAssigneeIds,
    setDueDate,
    setAll,
    clearAll,
  };
}

/** True if any filter is non-empty. */
export function hasActiveFilters(f: TaskFilters): boolean {
  return (
    f.search.trim().length > 0 ||
    f.status.length > 0 ||
    f.priority.length > 0 ||
    f.assigneeIds.length > 0 ||
    (f.dueDate && f.dueDate !== 'all')
  );
}

/** Shared predicate to match tasks against TaskFilters */
export function matchesTaskFilters(
  t: TaskWithPeople,
  filters: TaskFilters,
  currentUserId?: string,
): boolean {
  const needle = filters.search.trim().toLowerCase();
  const statusSet = new Set(filters.status);
  const prioritySet = new Set(filters.priority);
  const assigneeSet = new Set(filters.assigneeIds);

  if (statusSet.size > 0 && !statusSet.has(t.status)) return false;
  if (prioritySet.size > 0 && !prioritySet.has(t.priority)) return false;

  if (assigneeSet.size > 0) {
    const matched = filters.assigneeIds.some((id) => {
      if (id === '__unassigned__') return !t.assigneeId;
      if (id === '__assigned_to_me__' && currentUserId) return t.assigneeId === currentUserId;
      return t.assigneeId === id;
    });
    if (!matched) return false;
  }

  if (needle && !t.title.toLowerCase().includes(needle)) return false;

  if (filters.dueDate && !matchesDuePreset(t, filters.dueDate)) return false;

  return true;
}
