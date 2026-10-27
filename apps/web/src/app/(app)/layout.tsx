import type { ReactNode } from 'react';

import { SessionGate } from '@/components/auth/session-gate';
import { CommandPalette } from '@/components/command-palette/command-palette';
import { AppChrome } from '@/components/shell/app-chrome';
import { AppRealtime } from '@/components/shell/app-realtime';
import { ConnectionBanner } from '@/components/shell/connection-banner';
import { GlobalHotkeys } from '@/components/shell/global-hotkeys';
import { SupportSessionBanner } from '@/components/shell/support-session-banner';

/**
 * Authenticated app shell.
 *
 * `<AppChrome />` picks the navigation chrome from the user's appearance
 * preference: the default top-bar pill nav, or the opt-in side rail. Both
 * render the same children, so individual pages are unaffected by the choice
 * and keep owning their own secondary nav (project view tabs, settings
 * sub-pages).
 *
 * `<GlobalRealtime />` boots the chat socket, presence, push subscription,
 * incoming-call modal and notification dispatcher at the app-shell level
 * so chat notifications and calls keep working on every route - not just
 * `/chat`. It sits OUTSIDE the chrome so switching layouts never tears down
 * the socket. `<ConnectionBanner />` shows "Reconnecting…" while that socket
 * (or the mail push stream, on /mail) is down. Theme is applied at the root
 * layout above this one. In a read only support session `<AppRealtime />`
 * mounts neither the call provider nor `<GlobalRealtime />`: chat, calls and
 * notifications are the operator's own and the API refuses them there.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <AppRealtime>
        <AppChrome>{children}</AppChrome>
        <CommandPalette />
        <GlobalHotkeys />
        <ConnectionBanner />
        <SupportSessionBanner />
      </AppRealtime>
    </SessionGate>
  );
}
