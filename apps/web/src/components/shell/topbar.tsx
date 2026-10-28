'use client';

import {
  Bell,
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Clock,
  Download,
  FileText,
  FolderKanban,
  Home,
  LayoutDashboard,
  LogOut,
  Mail,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ComponentType } from 'react';

import { Logo } from '@/components/branding/logo';
import { NotificationBell } from '@/components/shell/notification-bell';
import { UserAvatar } from '@/components/ui/avatar';
import { clearAppAppearance } from '@/lib/app-prefs';
import { authClient } from '@/lib/auth-client';
import { clearAllInAppNotifications } from '@/lib/in-app-notifications';
import { useSessionContext } from '@/components/auth/session-gate';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { useDesktopNotifications } from '@/hooks/use-desktop-notifications';
import { useNavPrefs } from '@/hooks/use-nav-prefs';
import { useActiveSupportSession } from '@/hooks/use-support-access';
import { usePermissions } from '@/hooks/use-permissions';
import { unregisterNativePush } from '@/hooks/use-native-push';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

/**
 * Pill nav - centered, gradient-filled pill that floats over the blush topbar.
 * The pill is the only navigation chrome at the root; sub-navs live with their
 * feature, not here.
 */
export function TopBar() {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSessionContext();
  const workspace = useCurrentWorkspace();
  const user = session.data?.user;
  // Effective company permissions (custom roles + overrides).
  const perms = usePermissions();
  const isAdmin = perms.isOrgAdmin;
  // HR isn't a system admin, so it never sees the Admin pill - but it owns
  // attendance + timesheet management, which live inside the /admin shell
  // (those routes already admit HR). Give HR its own entry point there.
  const isHr = perms.isHr && !perms.isOrgAdmin;
  // Financials is org-role gated the same way HR is: a workspace OWNER does
  // NOT get money access by owning a workspace. Mirrors `hasFinanceAccess`
  // in @botss/auth, which is what the API actually enforces.
  const isFinance = perms.isFinance && !perms.isOrgAdmin;
  // Leads/Clients are shown to the sales roles and workspace admins, and to
  // anyone who has a lead or client assigned to them. Only the server can see
  // the assignment half, so the answer is fetched rather than derived here.
  const sales = useSalesAccess();
  const nav = useNavPrefs(user?.id ?? '');
  // A read only support session hides Mail and Chat (the API refuses both)
  // and never subscribes the operator's own account to notifications.
  const inSupport = useActiveSupportSession() !== null;
  useDesktopNotifications(inSupport ? null : (user?.id ?? null));

  const queryClient = useQueryClient();

  const onSignOut = async () => {
    // Stop this device receiving the signed-out user's native push, then end
    // the session. Best-effort - never block sign-out on it.
    await unregisterNativePush().catch(() => undefined);
    try {
      const res = await authClient.signOut();
      // 400/401 mean the session is already gone - carry on signing out.
      if (res.error && res.error.status !== 400 && res.error.status !== 401) {
        toastError(res.error, "Couldn't sign out. Try again in a moment.");
        return;
      }
    } catch (err) {
      toastError(err, "Couldn't sign out. Try again in a moment.");
      return;
    }
    // Wipe the previous account's cached data so signing in as a different
    // user on the same browser doesn't surface the prior user's notifications
    // or other cached queries.
    queryClient.clear();
    clearAllInAppNotifications();
    clearAppAppearance();
    router.replace('/sign-in');
    router.refresh();
  };

  const isActive = (prefix: string): boolean => {
    if (!pathname) return false;
    if (prefix === '/home') return pathname === '/home';
    return pathname.startsWith(prefix);
  };

  // Inline pill items - kept tight; everything else collapses into "More".
  type NavItem = {
    key: string;
    href: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
    prefkey?: string;
  };

  const inlineItems: NavItem[] = [
    { key: 'home', href: '/home', label: 'Home', icon: Home, prefkey: 'home' },
    {
      key: 'dashboard',
      href: '/dashboard',
      label: 'Dashboard',
      icon: LayoutDashboard,
      prefkey: 'dashboard',
    },
    {
      key: 'projects',
      href: '/projects',
      label: 'Projects',
      icon: FolderKanban,
      prefkey: 'projects',
    },
    { key: 'mail', href: '/mail', label: 'Mail', icon: Mail, prefkey: 'mail' },
    { key: 'chat', href: '/chat', label: 'Chat', icon: MessageSquare, prefkey: 'chat' },
    { key: 'todo', href: '/todo', label: 'Todos', icon: CheckSquare, prefkey: 'todo' },
  ];

  const moreItems: NavItem[] = [
    {
      key: 'calendar',
      href: '/calendar',
      label: 'Calendar',
      icon: CalendarDays,
      prefkey: 'calendar',
    },
    {
      key: 'timesheets',
      href: '/timesheets',
      label: 'Timesheets',
      icon: Clock,
      prefkey: 'timesheets',
    },
    { key: 'leads', href: '/leads', label: 'Leads', icon: UserPlus, prefkey: 'projects' },
    { key: 'clients', href: '/clients', label: 'Clients', icon: Users, prefkey: 'projects' },
    {
      key: 'financials',
      href: '/financials',
      label: 'Financials',
      icon: Wallet,
      prefkey: 'financials',
    },
    {
      key: 'documents',
      href: '/documents',
      label: 'Documents',
      icon: FileText,
      prefkey: 'projects',
    },
  ];

  // Leads and Clients are gated independently: a user can be assigned clients
  // but no leads, and should then see only the Clients tab.
  const roleVisible: Record<string, boolean> = {
    leads: sales.leads,
    clients: sales.clients,
    financials: isAdmin || isFinance,
    ...(inSupport ? { mail: false, chat: false } : {}),
  };
  const isAllowed = (i: NavItem): boolean =>
    (!i.prefkey || nav.isVisible(i.prefkey)) && (roleVisible[i.key] ?? true);
  const visibleInline = inlineItems.filter(isAllowed);
  const visibleMore = moreItems.filter(isAllowed);

  return (
    <header className="bg-bg-app sticky top-0 z-20 flex h-16 items-center justify-between gap-3 px-4 sm:px-6">
      {/* Left: brand mark. Mobile shows the icon-only variant so the wide
          wordmark doesn't crowd the centered nav pill on narrow screens;
          tablet/desktop (sm and up) get the full wordmark from
          `/branding/logo.svg`. Both variants source from the same
          branding folder. */}
      <Link
        href="/home"
        aria-label="Home"
        className="focus-visible:shadow-focus rounded focus-visible:outline-none"
      >
        <Logo variant="icon" size="sm" className="sm:hidden" />
        <Logo variant="full" size="sm" className="hidden sm:inline-block" />
      </Link>

      {/* Center: pill nav */}
      <nav
        aria-label="Primary"
        className="bg-brand-gradient shadow-pill hidden items-center gap-1 rounded-full px-3 py-1.5 md:flex"
      >
        {visibleInline.map((item) => (
          <PillNavItem
            key={item.key}
            href={item.href}
            active={isActive(item.href)}
            label={item.label}
            icon={item.icon}
          />
        ))}
        {visibleMore.length > 0 ? <MoreMenu items={visibleMore} isActive={isActive} /> : null}
        {isAdmin && nav.isVisible('admin') ? (
          <PillNavItem href="/admin" active={isActive('/admin')} label="Admin" icon={ShieldCheck} />
        ) : null}
        {isHr ? (
          <PillNavItem
            href="/admin/attendance"
            active={isActive('/admin')}
            label="HR"
            icon={UserCog}
          />
        ) : null}
      </nav>

      {/* Right: workspace switcher, notifications, settings, avatar, logout */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => router.push('/select-workspace')}
          className="border-line hover:border-line-strong focus-visible:shadow-focus hidden h-9 items-center gap-2 rounded-full border bg-white px-3 text-sm transition-all focus-visible:outline-none sm:inline-flex"
          title="Switch workspace"
        >
          <span className="text-brand-gradient hidden font-medium md:inline">
            {workspace.data?.name ?? 'Workspace'}
          </span>
          <ChevronDown className="text-ink-muted h-3.5 w-3.5" />
        </button>

        <NotificationBell />

        <Link
          href="/download"
          aria-label="Download desktop app"
          title="Download desktop app"
          className={cn(
            'text-ink-muted hover:text-ink hover:shadow-soft grid h-9 w-9 place-items-center rounded-full transition-all hover:bg-white',
            isActive('/download') && 'text-ink shadow-soft bg-white',
          )}
        >
          <Download className="h-4 w-4" />
        </Link>

        {nav.isVisible('settings') ? (
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className={cn(
              'text-ink-muted hover:text-ink hover:shadow-soft grid h-9 w-9 place-items-center rounded-full transition-all hover:bg-white',
              isActive('/settings') && 'text-ink shadow-soft bg-white',
            )}
          >
            <Settings className="h-4 w-4" />
          </Link>
        ) : null}

        <UserMenu
          name={user?.name ?? ''}
          email={user?.email ?? ''}
          image={user?.image ?? null}
          onSignOut={onSignOut}
        />

        <button
          type="button"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
          className="text-ink-muted hover:text-state-error hover:shadow-soft hidden h-9 w-9 place-items-center rounded-full transition-all hover:bg-white sm:grid"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>

      {/* Mobile pill (slim) */}
      <nav
        aria-label="Primary mobile"
        className="bg-brand-gradient shadow-pill absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-full px-2 py-1 md:hidden"
      >
        {visibleInline.slice(0, 3).map((item) => (
          <PillNavItem
            key={item.key}
            href={item.href}
            active={isActive(item.href)}
            label=""
            icon={item.icon}
            compact
          />
        ))}
        {/* The right-hand Download icon sits behind this centered pill on
            narrow screens, so also expose it here where it can't be covered. */}
        <MoreMenu
          items={[
            ...visibleInline.slice(3),
            ...visibleMore,
            { key: 'download', href: '/download', label: 'Download app', icon: Download },
          ]}
          isActive={isActive}
          compact
        />
      </nav>
    </header>
  );
}

function PillNavItem({
  href,
  active,
  label,
  icon: Icon,
  compact = false,
}: {
  href: string;
  active: boolean;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  compact?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex select-none items-center gap-1.5 rounded-full text-[13px] font-medium transition-all duration-200',
        compact ? 'px-2 py-1' : 'px-3 py-1.5',
        'text-white/85 hover:bg-white/10 hover:text-white',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        active && 'bg-white/[0.18] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.15)]',
      )}
    >
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      {label}
    </Link>
  );
}

function MoreMenu({
  items,
  isActive,
  compact = false,
}: {
  items: Array<{
    key: string;
    href: string;
    label: string;
    icon: ComponentType<{ className?: string }>;
  }>;
  isActive: (href: string) => boolean;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anyActive = items.some((i) => isActive(i.href));
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex select-none items-center gap-1 rounded-full text-[13px] font-medium transition-all duration-200',
          compact ? 'px-2 py-1' : 'px-3 py-1.5',
          'text-white/85 hover:bg-white/10 hover:text-white',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
          anyActive && 'bg-white/[0.18] text-white',
        )}
      >
        More
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="menu"
          className="border-line shadow-popover absolute right-0 z-30 mt-2 w-56 rounded-lg border bg-white py-1.5"
        >
          {items.map((item) => {
            const Icon = item.icon;
            const itemActive = isActive(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                role="menuitem"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 text-sm transition-colors',
                  itemActive ? 'bg-bg-subtle text-ink font-medium' : 'text-ink hover:bg-bg-subtle',
                )}
              >
                <Icon className="text-ink-muted h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function UserMenu({
  name,
  email,
  image,
  onSignOut,
}: {
  name: string;
  email: string;
  image: string | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="hover:shadow-soft focus-visible:shadow-focus flex h-9 items-center gap-2 rounded-full transition-all focus-visible:outline-none"
      >
        <UserAvatar size="md" name={name || email} image={image} online />
      </button>

      {open ? (
        <div
          role="menu"
          className="border-line shadow-popover absolute right-0 z-30 mt-2 w-60 rounded-lg border bg-white py-1.5"
        >
          <div className="border-line border-b px-3 py-2.5">
            <div className="text-ink truncate text-sm font-semibold">{name || 'Account'}</div>
            <div className="text-ink-muted truncate text-xs">{email}</div>
          </div>
          <Link
            href="/settings"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            className="text-ink hover:bg-bg-subtle flex items-center gap-2 px-3 py-2 text-sm"
          >
            <Settings className="text-ink-muted h-3.5 w-3.5" />
            Settings
          </Link>
          <Link
            href="/dashboard"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            className="text-ink hover:bg-bg-subtle flex items-center gap-2 px-3 py-2 text-sm"
          >
            <Bell className="text-ink-muted h-3.5 w-3.5" />
            Dashboard
          </Link>
          <button
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSignOut}
            className="text-state-error hover:bg-tint-error flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
