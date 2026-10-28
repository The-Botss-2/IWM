'use client';

import Link from 'next/link';

import { Check, Droplet, Monitor, Moon, Sparkles, Sun, Type } from 'lucide-react';

import {
  type AppBodyMode,
  type AppNavLayout,
  type AppTheme,
  GRADIENT_PRESETS,
  NAV_LAYOUTS,
  setAppAppearance,
  UI_SCALES,
  useAppAppearance,
} from '@/lib/app-prefs';
import { cn } from '@/lib/utils';

/**
 * /settings/appearance - picks the app-wide theme (light / dark / follow OS)
 * and the brand gradient used across primary buttons, sidebar, FAB, etc.
 *
 * Changes apply instantly through `app-prefs.ts` (localStorage cache + a
 * custom event the ThemeMount picks up without a route reload) and are saved
 * to the user's account by `useUserPreferencesSync`, so they follow the
 * person to every device.
 */

const THEMES: { id: AppTheme; label: string; description: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', description: 'Always light theme.', icon: Sun },
  { id: 'dark', label: 'Dark', description: 'Always dark theme.', icon: Moon },
  {
    id: 'system',
    label: 'System',
    description: 'Follow operating system preference.',
    icon: Monitor,
  },
];

const BODY_MODES: { id: AppBodyMode; label: string; description: string; icon: typeof Sun }[] = [
  {
    id: 'solid',
    label: 'Solid surface',
    description: 'Calm neutral background - default.',
    icon: Droplet,
  },
  {
    id: 'gradient',
    label: 'Brand gradient wash',
    description: 'Subtle gradient behind every page.',
    icon: Sparkles,
  },
];

export default function AppearanceSettingsPage() {
  const appearance = useAppAppearance();

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-ink mb-1 text-lg font-semibold dark:text-slate-100">Navigation</h2>
        <p className="text-ink-muted mb-4 text-sm">
          Where primary navigation lives, and how the pages around it look. Both layouts show the
          same pages with the same permissions, and you can switch back at any time. Saved to your
          account. To choose which sections appear, see{' '}
          <Link href="/settings/navigation" className="underline">
            Navigation
          </Link>
          .
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {NAV_LAYOUTS.map((n) => {
            const active = (appearance.navLayout ?? 'topbar') === n.id;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setAppAppearance({ navLayout: n.id })}
                aria-pressed={active}
                className={cn(
                  'group relative flex flex-col gap-3 rounded-lg border p-3 text-left transition-all',
                  'focus-visible:shadow-focus focus-visible:outline-none',
                  active
                    ? 'border-brand-purple bg-brand-gradient-soft shadow-soft'
                    : 'border-line hover:border-line-strong bg-white dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                )}
              >
                <NavLayoutPreview layout={n.id} />
                <span>
                  <span className="text-ink block text-sm font-medium dark:text-slate-100">
                    {n.label}
                  </span>
                  <span className="text-ink-muted block text-xs">{n.description}</span>
                </span>
                {active ? (
                  <span className="bg-brand-purple absolute right-3 top-3 rounded-full p-1 text-white">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-ink mb-1 text-lg font-semibold dark:text-slate-100">Display size</h2>
        <p className="text-ink-muted mb-4 text-sm">
          Scales the whole app - text, spacing, and controls - like a zoom level. Applies instantly
          to every page and follows you to every device.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {UI_SCALES.map((s) => {
            const active = (appearance.uiScale ?? 'md') === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setAppAppearance({ uiScale: s.id })}
                aria-pressed={active}
                className={cn(
                  'group relative flex flex-col items-start gap-2 rounded-lg border px-4 py-3 text-left transition-all',
                  'focus-visible:shadow-focus focus-visible:outline-none',
                  active
                    ? 'border-brand-purple bg-brand-gradient-soft shadow-soft'
                    : 'border-line hover:border-line-strong bg-white dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                )}
              >
                <Type
                  className={cn(
                    active ? 'text-brand-purple' : 'text-ink-muted dark:text-slate-400',
                  )}
                  style={{ width: s.rootPx, height: s.rootPx }}
                  aria-hidden
                />
                <span className="text-ink block text-sm font-medium dark:text-slate-100">
                  {s.label}
                </span>
                <span className="text-ink-muted block text-xs">{s.description}</span>
                {active ? (
                  <span className="bg-brand-purple absolute right-3 top-3 rounded-full p-1 text-white">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-ink mb-1 text-lg font-semibold dark:text-slate-100">Theme</h2>
        <p className="text-ink-muted mb-4 text-sm">
          Affects every page in the CRM. Components without dark-mode styling yet will keep their
          light look - coverage rolls out incrementally.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {THEMES.map((t) => {
            const Icon = t.icon;
            const active = appearance.theme === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setAppAppearance({ theme: t.id })}
                aria-pressed={active}
                className={cn(
                  'group relative flex flex-col items-start gap-2 rounded-lg border px-4 py-3 text-left transition-all',
                  'focus-visible:shadow-focus focus-visible:outline-none',
                  active
                    ? 'border-brand-purple bg-brand-gradient-soft shadow-soft'
                    : 'border-line hover:border-line-strong bg-white dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600',
                )}
              >
                <Icon
                  className={cn(
                    'h-5 w-5',
                    active ? 'text-brand-purple' : 'text-ink-muted dark:text-slate-400',
                  )}
                  aria-hidden
                />
                <span className="text-ink block text-sm font-medium dark:text-slate-100">
                  {t.label}
                </span>
                <span className="text-ink-muted block text-xs">{t.description}</span>
                {active ? (
                  <span className="bg-brand-purple absolute right-3 top-3 rounded-full p-1 text-white">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-ink mb-1 text-lg font-semibold dark:text-slate-100">Brand gradient</h2>
        <p className="text-ink-muted mb-4 text-sm">
          Used by every primary button, the floating action button, settings nav, and the sign-in
          panel. Changes apply instantly to every page.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GRADIENT_PRESETS.map((preset) => {
            const active = appearance.gradientId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => setAppAppearance({ gradientId: preset.id })}
                aria-pressed={active}
                className={cn(
                  'group relative overflow-hidden rounded-lg border p-1 text-left transition-all',
                  'focus-visible:shadow-focus focus-visible:outline-none',
                  active
                    ? 'border-brand-purple shadow-soft'
                    : 'border-line hover:border-line-strong dark:border-slate-700 dark:hover:border-slate-600',
                )}
              >
                <div
                  className="h-20 w-full rounded-md"
                  style={{ backgroundImage: preset.gradient }}
                  aria-hidden
                />
                <div className="flex items-center justify-between px-2 py-2">
                  <span className="text-ink text-sm font-medium dark:text-slate-100">
                    {preset.label}
                  </span>
                  {active ? (
                    <span className="bg-brand-purple rounded-full p-1 text-white">
                      <Check className="h-3 w-3" aria-hidden />
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-ink mb-1 text-lg font-semibold">Body background</h2>
        <p className="text-ink-muted mb-4 text-sm">
          Solid uses the theme&rsquo;s neutral surface (blush on light, dark on dark). Gradient
          washes the whole CRM in the active brand gradient - cards and panels still read on top.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {BODY_MODES.map((m) => {
            const Icon = m.icon;
            const active = (appearance.bodyMode ?? 'solid') === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setAppAppearance({ bodyMode: m.id })}
                aria-pressed={active}
                className={cn(
                  'group relative flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all',
                  'focus-visible:shadow-focus focus-visible:outline-none',
                  active
                    ? 'border-brand-purple bg-brand-gradient-soft shadow-soft'
                    : 'border-line bg-bg-surface hover:border-line-strong',
                )}
              >
                <Icon
                  className={cn('h-5 w-5', active ? 'text-brand-purple' : 'text-ink-muted')}
                  aria-hidden
                />
                <div className="flex-1">
                  <span className="text-ink block text-sm font-medium">{m.label}</span>
                  <span className="text-ink-muted block text-xs">{m.description}</span>
                </div>
                {active ? (
                  <span className="bg-brand-purple rounded-full p-1 text-white">
                    <Check className="h-3 w-3" aria-hidden />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * Scale miniature of each shell. Proportions mirror the real thing (rail 68 /
 * sidebar 250 / page, versus a full-width bar over a page) so the choice is
 * legible without applying it first.
 */
function NavLayoutPreview({ layout }: { layout: AppNavLayout }) {
  if (layout === 'rail') {
    return (
      <span aria-hidden className="border-line flex h-20 w-full overflow-hidden rounded-md border">
        <span className="flex w-[9%] flex-col items-center gap-1 bg-[#14161A] py-1.5">
          <span className="bg-brand-gradient h-1.5 w-1.5 rounded-sm" />
          <span className="h-1 w-2 rounded-sm bg-white/25" />
          <span className="h-1 w-2 rounded-sm bg-white/15" />
          <span className="h-1 w-2 rounded-sm bg-white/15" />
        </span>
        <span className="flex w-[30%] flex-col gap-1 bg-[#1B1E24] p-1.5">
          <span className="h-1.5 w-full rounded-sm bg-white/10" />
          <span className="bg-brand-gradient h-1 w-3/4 rounded-sm" />
          <span className="h-1 w-2/3 rounded-sm bg-white/10" />
          <span className="h-1 w-3/5 rounded-sm bg-white/10" />
        </span>
        <span className="bg-bg-subtle flex-1" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="border-line flex h-20 w-full flex-col overflow-hidden rounded-md border"
    >
      <span className="bg-bg-subtle flex items-center justify-center py-2">
        <span className="bg-brand-gradient h-2 w-1/2 rounded-full" />
      </span>
      <span className="bg-bg-subtle flex-1" />
    </span>
  );
}
