'use client';

import Link from 'next/link';

import { Compass, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DASHBOARD_WIDGET_META } from '@/components/dashboard/dashboard-widgets';
import {
  PERSONAL_DASHBOARD_WIDGETS,
  WORKSPACE_DASHBOARD_WIDGETS,
  type DashboardWidgetId,
} from '@/hooks/use-dashboard-prefs';

interface Props {
  open: boolean;
  onClose: () => void;
  isVisible: (id: DashboardWidgetId) => boolean;
  toggleWidget: (id: DashboardWidgetId) => void;
}

/**
 * Customise panel for the Dashboard. Three sections:
 *
 * 1. Workspace summary widgets (data scoped to the current workspace).
 * 2. Personal widgets (data scoped to the signed-in user).
 * 3. A pointer to Settings > Navigation, which owns navbar customisation
 *    now that it applies to both the top bar and the rail.
 *
 * Each widget toggle persists to localStorage so the user keeps their
 * layout across reloads and tab switches.
 */
export function CustomisePanel({ open, onClose, isVisible, toggleWidget }: Props) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Customise dashboard"
      className="bg-ink/40 fixed inset-0 z-40 flex justify-end"
      onClick={onClose}
    >
      <aside
        className="border-line shadow-drawer h-full w-[min(420px,92vw)] overflow-y-auto border-l bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-line sticky top-0 z-10 flex items-center justify-between border-b bg-white px-4 py-3">
          <h2 className="text-ink text-base font-semibold">Customise dashboard</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="text-ink-muted h-7 min-h-0 w-7 min-w-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="space-y-6 p-4">
          <WidgetSection
            title="Workspace summary"
            subtitle="Counts, charts, and feeds scoped to the current workspace."
            ids={WORKSPACE_DASHBOARD_WIDGETS}
            isVisible={isVisible}
            toggleWidget={toggleWidget}
          />

          <WidgetSection
            title="Personal"
            subtitle="Your tasks, todos, timer, and calendar."
            ids={PERSONAL_DASHBOARD_WIDGETS}
            isVisible={isVisible}
            toggleWidget={toggleWidget}
          />

          {/* Navigation customisation lives in Settings now. */}
          <section>
            <h3 className="text-ink-muted mb-2 text-xs font-semibold uppercase tracking-wide">
              Navigation
            </h3>
            <p className="text-ink-muted mb-3 text-xs">
              Which sections appear in the navbar, your layout, and the keyboard shortcuts now live
              in Settings, so they are reachable from anywhere rather than only from this panel.
            </p>
            <Link
              href="/settings/navigation"
              className="border-line text-ink hover:bg-bg-subtle inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors"
            >
              <Compass className="h-4 w-4" aria-hidden />
              Open navigation settings
            </Link>
          </section>
        </div>
      </aside>
    </div>
  );
}

function WidgetSection({
  title,
  subtitle,
  ids,
  isVisible,
  toggleWidget,
}: {
  title: string;
  subtitle: string;
  ids: readonly DashboardWidgetId[];
  isVisible: (id: DashboardWidgetId) => boolean;
  toggleWidget: (id: DashboardWidgetId) => void;
}) {
  const allOn = ids.every((id) => isVisible(id));
  const someOn = !allOn && ids.some((id) => isVisible(id));
  const toggleAll = () => {
    // If anything is on, turn the whole group off. Otherwise turn it all on.
    // Each id is toggled independently so the underlying store stays in sync.
    const turnOn = !someOn && !allOn;
    for (const id of ids) {
      if (turnOn && !isVisible(id)) toggleWidget(id);
      else if (!turnOn && isVisible(id)) toggleWidget(id);
    }
  };
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-ink-muted text-xs font-semibold uppercase tracking-wide">{title}</h3>
        <button
          type="button"
          onClick={toggleAll}
          className="text-brand-gradient focus-visible:shadow-focus rounded-sm text-[11px] font-medium hover:underline focus-visible:outline-none"
        >
          {allOn ? 'Hide all' : 'Show all'}
        </button>
      </div>
      <p className="text-ink-muted mb-3 text-xs">{subtitle}</p>
      <ul className="space-y-2" role="list">
        {ids.map((id) => {
          const meta = DASHBOARD_WIDGET_META[id];
          const Icon = meta.icon;
          const visible = isVisible(id);
          return (
            <li
              key={id}
              className="border-line flex items-start gap-3 rounded-md border px-3 py-2.5"
            >
              <Icon className="text-brand-purple mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-ink text-sm font-medium">{meta.title}</div>
                <div className="text-ink-muted text-xs">{meta.description}</div>
              </div>
              <label className="inline-flex items-center">
                <input
                  id={`widget-toggle-${id}`}
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggleWidget(id)}
                  className="accent-brand-purple h-4 w-4"
                  aria-label={`Toggle ${meta.title}`}
                />
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
