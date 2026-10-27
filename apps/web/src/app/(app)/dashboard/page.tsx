'use client';

import { SlidersHorizontal } from 'lucide-react';
import dynamic from 'next/dynamic';
import { Suspense, useState } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { CalendarMiniWidget } from '@/components/dashboard/calendar-mini-widget';
import { CustomisePanel } from '@/components/dashboard/customise-panel';
import { MyTodosWidget } from '@/components/dashboard/my-todos-widget';
import { RunningTimerWidget } from '@/components/dashboard/running-timer-widget';
import { UpcomingTasksWidget } from '@/components/dashboard/upcoming-tasks-widget';
import { WeeklyHoursWidget } from '@/components/dashboard/weekly-hours-widget';
import { ActivityFeedWidget } from '@/components/dashboard/workspace/activity-feed';
import { DocActivityHeatmapWidget } from '@/components/dashboard/workspace/doc-heatmap';
import { WorkspaceKpiStrip } from '@/components/dashboard/workspace/kpi-strip';
import { LeadFunnelWidget } from '@/components/dashboard/workspace/lead-funnel';
import { RecentByUserWidget } from '@/components/dashboard/workspace/recent-by-user';
import { SprintProgressWidget } from '@/components/dashboard/workspace/sprint-progress';
import { TopPerformersWidget } from '@/components/dashboard/workspace/top-performers';
import { UpcomingDeadlinesWidget } from '@/components/dashboard/workspace/upcoming-deadlines';
import { WorkloadWidget } from '@/components/dashboard/workspace/workload';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { WidgetErrorBoundary } from '@/components/ui/widget-error-boundary';
import { DashboardFilterBar } from '@/components/dashboard/dashboard-filter-bar';
import { DashboardUrlWatcher } from '@/components/dashboard/dashboard-url-watcher';
import { WorkOverviewWidget } from '@/components/dashboard/work-overview-widget';
import {
  PERSONAL_DASHBOARD_WIDGETS,
  WORKSPACE_DASHBOARD_WIDGETS,
  useDashboardPrefs,
} from '@/hooks/use-dashboard-prefs';
import { useDashboardFilters } from '@/hooks/use-dashboard-filters';
import { useDashboardUrlSync } from '@/hooks/use-dashboard-url-sync';
import { useCurrentWorkspace } from '@/hooks/use-workspace';

// recharts is the heaviest dependency on the dashboard; the three chart
// widgets load it on demand (client-only - charts measure the DOM anyway)
// instead of shipping it in the route's first-load JS.
const chartLoading = () => <Skeleton className="h-[17rem] w-full rounded-xl" />;
const WeeklyCompletionChartWidget = dynamic(
  () =>
    import('@/components/dashboard/workspace/completion-chart').then((m) => ({
      default: m.WeeklyCompletionChartWidget,
    })),
  { ssr: false, loading: chartLoading },
);
const StatusDonutWidget = dynamic(
  () =>
    import('@/components/dashboard/workspace/status-donut').then((m) => ({
      default: m.StatusDonutWidget,
    })),
  { ssr: false, loading: chartLoading },
);
const HoursByProjectWidget = dynamic(
  () =>
    import('@/components/dashboard/workspace/hours-by-project').then((m) => ({
      default: m.HoursByProjectWidget,
    })),
  { ssr: false, loading: chartLoading },
);

/**
 * The Dashboard. Two stacked sections:
 *
 * 1. Workspace Summary - workspace-wide KPIs, charts, feeds. Data
 *    rescopes automatically when the user switches workspaces because
 *    every query inherits the API client's workspace header.
 * 2. Personal - the original user-scoped widgets.
 *
 * Each widget is independently toggleable in the Customise panel. The
 * panel also groups its checkboxes by section so the user can hide an
 * entire half of the dashboard quickly.
 */
export default function DashboardPage() {
  const session = useSessionContext();
  const workspace = useCurrentWorkspace();
  const userId = session.data?.user?.id ?? '';
  const dash = useDashboardPrefs(userId);
  const [customiseOpen, setCustomiseOpen] = useState(false);
  const workspaceId = useDashboardFilters((s) => s.workspaceId);
  // Filters <-> query string, so a filtered dashboard reloads and shares.
  // Widgets mount only once `ready`, i.e. after the URL's filters are in the
  // store, so their first queries are already the filtered ones.
  const urlSync = useDashboardUrlSync();

  const anyWorkspaceVisible = WORKSPACE_DASHBOARD_WIDGETS.some((id) => dash.isVisible(id));
  const anyPersonalVisible = PERSONAL_DASHBOARD_WIDGETS.some((id) => dash.isVisible(id));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-ink-muted text-xs font-medium">
            <span className="cursor-pointer hover:underline">Dashboard</span>
            <span className="mx-1">›</span>
            <span className="underline">{workspace.data?.name ?? 'Your workspace'}</span>
          </p>
          <h1 className="text-ink mt-2 text-2xl font-semibold">
            Good day, <span className="text-brand-gradient">welcome back</span>
          </h1>
          <p className="text-ink-muted mt-1 text-sm">
            Your widgets. Your navbar. Customise the view to fit how you work.
          </p>
        </div>
        <Button id="customise-dashboard" variant="secondary" onClick={() => setCustomiseOpen(true)}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Customise
        </Button>
      </header>

      <Suspense fallback={null}>
        <DashboardUrlWatcher onChange={urlSync.onUrlChange} />
      </Suspense>

      {!urlSync.ready ? (
        <div aria-busy="true" aria-label="Loading dashboard">
          <Skeleton className="mb-8 h-16 w-full rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-[17rem] w-full rounded-xl" />
            <Skeleton className="h-[17rem] w-full rounded-xl" />
          </div>
        </div>
      ) : (
        <>
          {/* Global Dashboard Filter Toolbar */}
          <div className="mb-8">
            <DashboardFilterBar overviewTasksEnabled={dash.isVisible('wsWorkOverview')} />
          </div>

          {/* --- Workspace summary --- */}
          {anyWorkspaceVisible ? (
            <section className="mb-10" aria-labelledby="workspace-summary-heading">
              <div className="mb-4 flex items-center justify-between gap-2">
                <h2
                  id="workspace-summary-heading"
                  className="text-ink-muted text-sm font-semibold uppercase tracking-wide"
                >
                  Workspace summary
                </h2>
                <span className="text-ink-muted text-[11px]">
                  {workspaceId ? 'Filtered workspace' : (workspace.data?.name ?? 'All Workspaces')}
                </span>
              </div>

              {dash.isVisible('wsWorkOverview') ? (
                <div className="mb-6">
                  <WidgetErrorBoundary title="the work overview">
                    <WorkOverviewWidget />
                  </WidgetErrorBoundary>
                </div>
              ) : null}

              {dash.isVisible('wsKpis') ? (
                <div className="mb-4">
                  <WidgetErrorBoundary title="the workspace numbers">
                    <WorkspaceKpiStrip />
                  </WidgetErrorBoundary>
                </div>
              ) : null}

              <div className="grid gap-4 lg:grid-cols-2">
                {dash.isVisible('wsCompletionChart') ? (
                  <WidgetErrorBoundary title="the completion chart">
                    <WeeklyCompletionChartWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsStatusDonut') ? (
                  <WidgetErrorBoundary title="the status chart">
                    <StatusDonutWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsWorkload') ? (
                  <WidgetErrorBoundary title="the workload">
                    <WorkloadWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsUpcomingDeadlines') ? (
                  <WidgetErrorBoundary title="upcoming deadlines">
                    <UpcomingDeadlinesWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsActivityFeed') ? (
                  <WidgetErrorBoundary title="the activity feed">
                    <ActivityFeedWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsLeadFunnel') ? (
                  <WidgetErrorBoundary title="the lead funnel">
                    <LeadFunnelWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsTopPerformers') ? (
                  <WidgetErrorBoundary title="top performers">
                    <TopPerformersWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsRecentByUser') ? (
                  <WidgetErrorBoundary title="recent activity by person">
                    <RecentByUserWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsSprintBurndown') ? (
                  <WidgetErrorBoundary title="sprint progress">
                    <SprintProgressWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsHoursByProject') ? (
                  <WidgetErrorBoundary title="hours by project">
                    <HoursByProjectWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('wsDocHeatmap') ? (
                  <div className="lg:col-span-2">
                    <WidgetErrorBoundary title="document activity">
                      <DocActivityHeatmapWidget />
                    </WidgetErrorBoundary>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}

          {/* --- Personal --- */}
          {anyPersonalVisible ? (
            <section aria-labelledby="personal-heading">
              <h2
                id="personal-heading"
                className="text-ink-muted mb-4 text-sm font-semibold uppercase tracking-wide"
              >
                Personal
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {dash.isVisible('todos') ? (
                  <WidgetErrorBoundary title="your todos">
                    <MyTodosWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('timer') ? (
                  <WidgetErrorBoundary title="the running timer">
                    <RunningTimerWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('weeklyHours') ? (
                  <WidgetErrorBoundary title="weekly hours">
                    <WeeklyHoursWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('upcomingTasks') ? (
                  <WidgetErrorBoundary title="upcoming tasks">
                    <UpcomingTasksWidget />
                  </WidgetErrorBoundary>
                ) : null}
                {dash.isVisible('calendarMini') ? (
                  <WidgetErrorBoundary title="the calendar">
                    <CalendarMiniWidget />
                  </WidgetErrorBoundary>
                ) : null}
              </div>
            </section>
          ) : null}

          {!anyWorkspaceVisible && !anyPersonalVisible ? (
            <div className="text-ink-muted shadow-soft rounded-xl bg-white p-10 text-center text-sm">
              Every widget is hidden. Hit Customise to turn some back on.
            </div>
          ) : null}
        </>
      )}

      <CustomisePanel
        open={customiseOpen}
        onClose={() => setCustomiseOpen(false)}
        isVisible={dash.isVisible}
        toggleWidget={dash.toggleWidget}
      />
    </div>
  );
}
