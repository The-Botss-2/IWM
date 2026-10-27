'use client';

import type { ReactNode } from 'react';

import { NavPanelProvider } from '@/components/shell/nav-panel-slot';
import { NavRailShell } from '@/components/shell/nav-rail';
import { TopBar } from '@/components/shell/topbar';
import { useUserPreferencesSync } from '@/hooks/use-user-preferences-sync';
import { useAppAppearance } from '@/lib/app-prefs';

/**
 * Picks the navigation chrome the user chose in Settings > Appearance and
 * wraps the page in it. Both branches render identical children, so no page
 * needs to know which shell it is inside, and switching is reversible with no
 * data migration.
 *
 * The top bar is the default and the fallback for every uncertain case - an
 * unset preference, unparseable localStorage, or a stored value from before
 * `navLayout` existed.
 *
 * ## On the usual flash-of-wrong-chrome problem
 *
 * `useAppAppearance` seeds from defaults and only reads localStorage in an
 * effect, so on its own it would render the top bar for a frame and then swap
 * the whole shell - remounting every page component underneath.
 *
 * That does not happen here, because this sits inside `SessionGate`, which
 * renders a spinner until the session query resolves over the network.
 * Children therefore first render well after mount, by which point the
 * appearance hook has already read localStorage. `ThemePreScript` separately
 * stamps `data-nav-layout` on `<html>` before hydration so the background and
 * any layout-dependent CSS are correct from the very first paint.
 *
 * If this component is ever hoisted above `SessionGate`, that reasoning stops
 * holding and it will need an explicit mount gate.
 */
export function AppChrome({ children }: { children: ReactNode }) {
  // Appearance + navigation settings follow the user across devices. Lives
  // here because this is the one always-mounted, signed-in-only spot.
  useUserPreferencesSync();
  const { navLayout } = useAppAppearance();

  // The provider wraps BOTH branches on purpose. Under the top bar no outlet
  // is ever mounted, so `useNavPanelAvailable()` reads false and features fall
  // back to rendering their sidebar inline - which is correct for that layout.
  if (navLayout === 'rail') {
    return (
      <NavPanelProvider>
        <NavRailShell>{children}</NavRailShell>
      </NavPanelProvider>
    );
  }

  return (
    <NavPanelProvider>
      {/* `--app-content-h` is the height a full-bleed page (chat, mail,
          calendar) actually has to work with. It is published by the chrome
          because only the chrome knows how tall its own bars are: pages used
          to hardcode `calc(100vh - 4rem)` for this top bar, which was simply
          wrong under the rail layout - the rail has no 4rem bar, so every
          such page came up 64px short and left a dead strip below its
          composer / footer. See NavRailShell for the rail's value. */}
      <div className="flex min-h-screen flex-col bg-bg-app text-ink [--app-content-h:calc(100vh-4rem)]">
        <TopBar />
        <main className="flex-1">{children}</main>
      </div>
    </NavPanelProvider>
  );
}
