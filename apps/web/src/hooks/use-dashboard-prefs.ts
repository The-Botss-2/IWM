'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Personal widgets - scoped to the signed-in user. These are the original
 * dashboard widgets and stay above the personal section.
 */
export const PERSONAL_DASHBOARD_WIDGETS = [
  'todos',
  'timer',
  'weeklyHours',
  'upcomingTasks',
  'calendarMini',
] as const;
type PersonalDashboardWidgetId = (typeof PERSONAL_DASHBOARD_WIDGETS)[number];

/**
 * Workspace summary widgets - scoped to the current workspace. Data
 * fetches inherit the workspace context from the API client header, so
 * switching workspaces automatically rescopes every widget here.
 */
export const WORKSPACE_DASHBOARD_WIDGETS = [
  'wsWorkOverview',
  // Wave 1
  'wsKpis',
  'wsCompletionChart',
  'wsStatusDonut',
  'wsWorkload',
  'wsUpcomingDeadlines',
  'wsActivityFeed',
  // Wave 2
  'wsLeadFunnel',
  'wsTopPerformers',
  'wsRecentByUser',
  // Wave 3
  'wsSprintBurndown',
  'wsDocHeatmap',
  'wsHoursByProject',
] as const;
type WorkspaceDashboardWidgetId = (typeof WORKSPACE_DASHBOARD_WIDGETS)[number];

export const DASHBOARD_WIDGETS = [
  ...PERSONAL_DASHBOARD_WIDGETS,
  ...WORKSPACE_DASHBOARD_WIDGETS,
] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGETS)[number];

const DEFAULT_VISIBLE: DashboardWidgetId[] = [...DASHBOARD_WIDGETS];

function keyFor(userId: string): string {
  return `dashboard_widgets_${userId}`;
}

function read(userId: string): DashboardWidgetId[] {
  if (typeof window === 'undefined') return DEFAULT_VISIBLE;
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return DEFAULT_VISIBLE;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE;
    const stored = parsed.filter((id): id is DashboardWidgetId =>
      (DASHBOARD_WIDGETS as readonly string[]).includes(id),
    );
    // Newly-added widget IDs default to on for existing users - preserves the
    // brief's "all widgets visible by default" contract when we expand the
    // registry between releases. Only IDs the user *explicitly* toggled off
    // should remain off, but storing positive-only state means any unknown-to-
    // storage ID gets folded in here.
    const known = new Set(stored);
    const union = stored.slice();
    for (const id of DASHBOARD_WIDGETS) {
      if (!known.has(id) && !isExplicitlyOff(userId, id)) {
        union.push(id);
      }
    }
    return union;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

/**
 * Tracks IDs the user has explicitly toggled OFF in this browser. Without
 * this, a newly added widget couldn't be distinguished from one the user
 * previously turned off - they'd both look like "not in the stored list".
 */
function offKeyFor(userId: string): string {
  return `dashboard_widgets_off_${userId}`;
}
function readOff(userId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(offKeyFor(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}
function writeOff(userId: string, off: Set<string>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(offKeyFor(userId), JSON.stringify([...off]));
}
function isExplicitlyOff(userId: string, id: string): boolean {
  return readOff(userId).has(id);
}

function write(userId: string, ids: DashboardWidgetId[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(keyFor(userId), JSON.stringify(ids));
  // Mirror to the off-set so future widget additions default-on cleanly.
  const off = new Set<string>();
  const visible = new Set(ids);
  for (const id of DASHBOARD_WIDGETS) {
    if (!visible.has(id)) off.add(id);
  }
  writeOff(userId, off);
}

export function useDashboardPrefs(userId: string): {
  visibleWidgets: DashboardWidgetId[];
  toggleWidget: (id: DashboardWidgetId) => void;
  setVisible: (ids: DashboardWidgetId[]) => void;
  isVisible: (id: DashboardWidgetId) => boolean;
} {
  const [visibleWidgets, setVisibleState] = useState<DashboardWidgetId[]>(DEFAULT_VISIBLE);

  useEffect(() => {
    if (!userId) return;
    setVisibleState(read(userId));
  }, [userId]);

  const setVisible = useCallback(
    (ids: DashboardWidgetId[]) => {
      setVisibleState(ids);
      if (userId) write(userId, ids);
    },
    [userId],
  );

  const toggleWidget = useCallback(
    (id: DashboardWidgetId) => {
      setVisibleState((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        if (userId) write(userId, next);
        return next;
      });
    },
    [userId],
  );

  const isVisible = useCallback(
    (id: DashboardWidgetId) => visibleWidgets.includes(id),
    [visibleWidgets],
  );

  return { visibleWidgets, toggleWidget, setVisible, isVisible };
}
