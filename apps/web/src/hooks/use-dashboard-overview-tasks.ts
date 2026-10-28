'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ListTasksQuery } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { selectDashboardFilterValues, useDashboardFilters } from '@/hooks/use-dashboard-filters';
import { dashboardTaskListQuery } from '@/lib/dashboard-filters';
import { parseYmd, toYmd } from '@/lib/date-range';
import { getApi } from '@/lib/api';

/** Rows loaded at once. Filters run server-side, so this only caps very
 *  broad views; the widget says when it is showing a partial set. */
const OVERVIEW_PAGE_SIZE = 500;

/**
 * Lives under the `tasks` prefix so every task mutation that invalidates
 * `['tasks']` refreshes the dashboard overview too.
 */
const dashboardOverviewTasksKey = (query: Partial<ListTasksQuery>) =>
  ['tasks', 'dashboard-overview', query] as const;

/**
 * Tasks behind the dashboard's Work Overview widget. Workspace, status,
 * priority, assignees, the due preset and the date range are applied by the
 * API (so no match is hidden behind a page cap); free-text search is applied
 * client-side by the widget. Shared by the widget and the filter bar through
 * the query cache, so there is a single fetch.
 *
 * `enabled: false` turns a consumer into a passive cache reader - the filter
 * bar uses that when the overview widget is hidden.
 */
export function useDashboardOverviewTasks(options: { enabled?: boolean } = {}) {
  const session = useSessionContext();
  const currentUserId = session.data?.user?.id ?? '';
  const values = useDashboardFilters(useShallow(selectDashboardFilterValues));
  // Due presets are relative to today; keying on the day keeps the query
  // stable within a day and rolls it over at midnight on the next render.
  const today = toYmd(new Date());
  const query = useMemo(
    () => dashboardTaskListQuery(values, currentUserId, parseYmd(today) ?? new Date()),
    [values, currentUserId, today],
  );
  return useQuery({
    queryKey: dashboardOverviewTasksKey(query),
    queryFn: () =>
      getApi().tasks.list({
        ...query,
        pageSize: OVERVIEW_PAGE_SIZE,
        sort: 'dueDate',
        order: 'asc',
      }),
    staleTime: 30_000,
    // Keep the old rows on screen while a filter change refetches.
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}
