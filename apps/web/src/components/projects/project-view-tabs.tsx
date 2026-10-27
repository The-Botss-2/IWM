'use client';

import {
  Archive,
  BarChart3,
  Bookmark,
  Calendar,
  CheckSquare,
  Code2,
  GitBranch,
  Inbox,
  KanbanSquare,
  LayoutDashboard,
  List,
  ListChecks,
  Settings,
  Target,
  Workflow,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export const PROJECT_VIEWS = [
  'summary',
  'board',
  'list',
  'backlog',
  'timeline',
  'calendar',
  'forms',
  'goals',
  'todos',
  'shortcuts',
  'development',
  'code',
  'archive',
  'settings',
] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number];

export const DEFAULT_VIEW: ProjectView = 'board';

export function parseProjectView(value: string | null | undefined): ProjectView {
  if (!value) return DEFAULT_VIEW;
  return (PROJECT_VIEWS as readonly string[]).includes(value)
    ? (value as ProjectView)
    : DEFAULT_VIEW;
}

const ICONS: Record<ProjectView, typeof KanbanSquare> = {
  summary: LayoutDashboard,
  board: KanbanSquare,
  list: List,
  backlog: Inbox,
  timeline: Workflow,
  calendar: Calendar,
  forms: ListChecks,
  goals: Target,
  todos: CheckSquare,
  shortcuts: Bookmark,
  development: GitBranch,
  code: Code2,
  archive: Archive,
  settings: Settings,
};

const LABELS: Record<ProjectView, string> = {
  summary: 'Summary',
  board: 'Board',
  list: 'List',
  backlog: 'Backlog',
  timeline: 'Timeline',
  calendar: 'Calendar',
  forms: 'Forms',
  goals: 'Goals',
  todos: 'Todos',
  shortcuts: 'Shortcuts',
  development: 'Development',
  code: 'Code',
  archive: 'Archive',
  settings: 'Settings',
};

export { BarChart3 };

export function useProjectView(): { view: ProjectView; setView: (next: ProjectView) => void } {
  const router = useRouter();
  const params = useSearchParams();
  const view = parseProjectView(params.get('view'));
  const setView = useCallback(
    (next: ProjectView) => {
      const sp = new URLSearchParams(params.toString());
      if (next === DEFAULT_VIEW) sp.delete('view');
      else sp.set('view', next);
      const qs = sp.toString();
      router.replace(qs ? `?${qs}` : '?', { scroll: false });
    },
    [params, router],
  );
  return { view, setView };
}

export function ProjectViewTabs({
  view,
  onChange,
}: {
  view: ProjectView;
  onChange: (next: ProjectView) => void;
}) {
  // Keyboard left/right navigation when the tab strip is focused.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const idx = PROJECT_VIEWS.indexOf(view);
      if (idx === -1) return;
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = (idx + delta + PROJECT_VIEWS.length) % PROJECT_VIEWS.length;
      onChange(PROJECT_VIEWS[next]!);
    }
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [view, onChange]);

  return (
    <Tabs value={view} onValueChange={(v) => onChange(v as ProjectView)}>
      <div
        ref={listRef}
        className="-mx-1 overflow-x-auto"
        role="tablist"
        aria-label="Project views"
        tabIndex={0}
      >
        <TabsList className="px-1">
          {PROJECT_VIEWS.map((v) => {
            const Icon = ICONS[v];
            return (
              <TabsTrigger key={v} value={v}>
                <Icon className="h-4 w-4" aria-hidden />
                <span>{LABELS[v]}</span>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
    </Tabs>
  );
}
