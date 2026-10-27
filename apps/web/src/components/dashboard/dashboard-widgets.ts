import {
  Activity,
  BarChart3,
  CalendarDays,
  CalendarRange,
  Clock,
  FileClock,
  Flame,
  Gauge,
  GitBranch,
  Layers,
  ListChecks,
  ListTodo,
  PieChart,
  Play,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

import type { DashboardWidgetId } from '@/hooks/use-dashboard-prefs';

export interface DashboardWidgetMeta {
  id: DashboardWidgetId;
  title: string;
  description: string;
  icon: LucideIcon;
}

export const DASHBOARD_WIDGET_META: Record<DashboardWidgetId, DashboardWidgetMeta> = {
  // --- Personal ---
  todos: {
    id: 'todos',
    title: 'My Todos',
    description: 'Next 5 open todos for today.',
    icon: ListTodo,
  },
  timer: {
    id: 'timer',
    title: 'Running Timer',
    description: 'Your active time entry, if any.',
    icon: Play,
  },
  weeklyHours: {
    id: 'weeklyHours',
    title: "This Week's Hours",
    description: 'Hours logged this week by project.',
    icon: Clock,
  },
  upcomingTasks: {
    id: 'upcomingTasks',
    title: 'Upcoming Tasks',
    description: 'Tasks assigned to you due in 7 days.',
    icon: ListChecks,
  },
  calendarMini: {
    id: 'calendarMini',
    title: 'Calendar',
    description: 'Mini month view with event dots.',
    icon: CalendarDays,
  },

  // --- Workspace summary ---
  wsWorkOverview: {
    id: 'wsWorkOverview',
    title: 'Work Overview',
    description: 'Interactive tasks table & cards with live filtering and status updates.',
    icon: Layers,
  },
  wsKpis: {
    id: 'wsKpis',
    title: 'Workspace KPIs',
    description: 'Active projects, completed this week, overdue, open leads.',
    icon: Gauge,
  },
  wsCompletionChart: {
    id: 'wsCompletionChart',
    title: 'Weekly completion',
    description: 'Tasks and todos completed per week, last 8 weeks.',
    icon: BarChart3,
  },
  wsStatusDonut: {
    id: 'wsStatusDonut',
    title: 'Tasks by status',
    description: 'Workspace task counts grouped by status.',
    icon: PieChart,
  },
  wsWorkload: {
    id: 'wsWorkload',
    title: 'Open tasks by member',
    description: 'Open tasks per assignee, sorted by load.',
    icon: Users,
  },
  wsUpcomingDeadlines: {
    id: 'wsUpcomingDeadlines',
    title: 'Upcoming deadlines',
    description: 'Tasks due in the next 7 days, workspace-wide.',
    icon: CalendarRange,
  },
  wsActivityFeed: {
    id: 'wsActivityFeed',
    title: 'Recent activity',
    description: 'Latest task updates across the workspace.',
    icon: Activity,
  },
  wsLeadFunnel: {
    id: 'wsLeadFunnel',
    title: 'Lead pipeline',
    description: 'Lead counts by stage with drop-off.',
    icon: Layers,
  },
  wsTopPerformers: {
    id: 'wsTopPerformers',
    title: 'Top performers',
    description: 'Members ranked by tasks completed this week.',
    icon: Flame,
  },
  wsRecentByUser: {
    id: 'wsRecentByUser',
    title: 'Recent tasks by user',
    description: 'Latest tasks grouped per assignee.',
    icon: Users,
  },
  wsSprintBurndown: {
    id: 'wsSprintBurndown',
    title: 'Sprint progress',
    description: 'Active sprints across the workspace, with completion ratio and days remaining.',
    icon: GitBranch,
  },
  wsDocHeatmap: {
    id: 'wsDocHeatmap',
    title: 'Document activity',
    description: 'Daily document edits over the last 12 weeks.',
    icon: FileClock,
  },
  wsHoursByProject: {
    id: 'wsHoursByProject',
    title: 'Hours by project',
    description: "This week's logged hours sliced by project.",
    icon: Target,
  },
};
