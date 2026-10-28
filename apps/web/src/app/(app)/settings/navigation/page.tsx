'use client';

import { useMemo } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useNavPrefs } from '@/hooks/use-nav-prefs';
import { usePermissions } from '@/hooks/use-permissions';
import { useSalesAccess } from '@/hooks/use-sales-access';
import {
  accessibleNav,
  NAV_GROUP_LABEL,
  type NavDestination,
  type NavGroup,
} from '@/lib/nav-registry';
import { NAV_LAYOUTS, setAppAppearance, useAppAppearance } from '@/lib/app-prefs';
import { cn } from '@/lib/utils';

const GROUP_ORDER: NavGroup[] = ['primary', 'workspace', 'money', 'admin'];

/**
 * One screen for everything navigation: which layout, which destinations, and
 * what the keyboard shortcuts are.
 *
 * It lists only what this user can actually reach - the role gates come from
 * the same registry the rail and top bar filter against, so the settings
 * screen can never offer a toggle for a section that would 404 or bounce.
 */
export default function NavigationSettingsPage() {
  const session = useSessionContext();
  const user = session.data?.user;
  const sales = useSalesAccess();
  const perms = usePermissions();
  const prefs = useNavPrefs(user?.id ?? '');
  const { navLayout } = useAppAppearance();

  const destinations = useMemo(
    () =>
      accessibleNav({
        systemRole: user?.systemRole ?? null,
        salesLeads: sales.leads,
        salesClients: sales.clients,
        companyPermissions: perms.company,
      }),
    [user?.systemRole, sales.leads, sales.clients, perms.company],
  );

  const grouped = useMemo(() => {
    const out = new Map<NavGroup, NavDestination[]>();
    for (const d of destinations) {
      const list = out.get(d.group) ?? [];
      list.push(d);
      out.set(d.group, list);
    }
    return out;
  }, [destinations]);

  const hiddenCount = destinations.filter((d) => !d.alwaysOn && !prefs.isVisible(d.id)).length;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-semibold">Navigation</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Choose your layout and which sections appear in it. These are your settings - they do not
          change what anyone else sees, and they never grant or remove access.
        </p>
      </header>

      {/* ---- Layout ---- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Layout</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {NAV_LAYOUTS.map((l) => {
            const active = navLayout === l.id;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => setAppAppearance({ navLayout: l.id })}
                aria-pressed={active}
                className={cn(
                  'rounded-lg border p-3 text-left transition-colors',
                  active
                    ? 'bg-brand-gradient border-transparent text-white'
                    : 'border-line bg-bg-surface hover:bg-bg-subtle',
                )}
              >
                <span className="block text-sm font-semibold">{l.label}</span>
                <span
                  className={cn(
                    'mt-0.5 block text-xs',
                    active ? 'text-white/85' : 'text-ink-muted',
                  )}
                >
                  {l.description}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ---- Sections ---- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Sections</h2>
            <p className="text-ink-muted text-xs">
              Applies to both layouts. Hidden sections stay reachable by URL, search and shortcut.
            </p>
          </div>
          {hiddenCount > 0 ? (
            <Button variant="secondary" size="sm" onClick={prefs.reset}>
              Show all ({hiddenCount} hidden)
            </Button>
          ) : null}
        </div>

        {GROUP_ORDER.map((group) => {
          const items = grouped.get(group);
          if (!items || items.length === 0) return null;
          return (
            <div key={group} className="space-y-1.5">
              <h3 className="text-ink-muted px-1 pt-2 text-[11px] font-bold uppercase tracking-wide">
                {NAV_GROUP_LABEL[group]}
              </h3>
              <ul
                className="divide-line border-line bg-bg-surface divide-y overflow-hidden rounded-lg border"
                role="list"
              >
                {items.map((d) => {
                  const Icon = d.icon;
                  const visible = prefs.isVisible(d.id);
                  return (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Icon className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{d.label}</span>
                          {d.alwaysOn ? <Badge tone="outline">Always on</Badge> : null}
                          {d.shortcut ? (
                            <kbd className="bg-bg-subtle text-ink-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
                              {d.shortcut}
                            </kbd>
                          ) : null}
                        </div>
                        <p className="text-ink-muted truncate text-xs">{d.description}</p>
                      </div>
                      <Checkbox
                        checked={visible}
                        disabled={d.alwaysOn}
                        onCheckedChange={() => prefs.toggle(d.id)}
                        aria-label={`Show ${d.label}`}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>

      {/* ---- Shortcuts ---- */}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
          <p className="text-ink-muted text-xs">
            Press the keys in sequence, not together. They do not fire while you are typing in a
            field.
          </p>
        </div>
        <ul
          className="divide-line border-line bg-bg-surface divide-y overflow-hidden rounded-lg border"
          role="list"
        >
          <li className="flex items-center gap-3 px-3 py-2.5">
            <kbd className="bg-bg-subtle text-ink-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
              ⌘K
            </kbd>
            <span className="text-sm">Search or jump to anything</span>
          </li>
          {destinations
            .filter((d) => d.shortcut)
            .map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                <kbd className="bg-bg-subtle text-ink-muted rounded px-1.5 py-0.5 font-mono text-[10px]">
                  {d.shortcut}
                </kbd>
                <span className="text-sm">Go to {d.label}</span>
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}
