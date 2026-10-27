'use client';

import {
  CalendarDays,
  CalendarRange,
  ArrowLeftRight,
  CheckSquare,
  ChevronDown,
  Clock,
  Download,
  FileText,
  FolderKanban,
  Hash,
  Home,
  LayoutDashboard,
  LogOut,
  Mail,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { Logo } from '@/components/branding/logo';
import {
  NavPanelOutlet,
  useNavPanelClaimed,
} from '@/components/shell/nav-panel-slot';
import { roomTitle } from '@/lib/chat-room-label';
import { NotificationBell } from '@/components/shell/notification-bell';
import { UserAvatar } from '@/components/ui/avatar';
import { Loader } from '@/components/ui/loader';
import { useChatRooms } from '@/hooks/use-chat';
import { useDesktopNotifications } from '@/hooks/use-desktop-notifications';
import { useNavPrefs } from '@/hooks/use-nav-prefs';
import { useActiveSupportSession } from '@/hooks/use-support-access';
import { usePermissions } from '@/hooks/use-permissions';
import { unregisterNativePush } from '@/hooks/use-native-push';
import { useProjects } from '@/hooks/use-projects';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { clearAppAppearance, setAppAppearance, useAppAppearance } from '@/lib/app-prefs';
import { authClient } from '@/lib/auth-client';
import { getChatSocket } from '@/lib/chat-socket';
import { clearAllInAppNotifications } from '@/lib/in-app-notifications';
import { cn } from '@/lib/utils';

/**
 * "Direction A - Rail" - the opt-in alternate navigation chrome from the UI
 * redesign project. Two fixed dark columns, then the page:
 *
 *   [68px icon rail] [250px contextual sidebar] [page]
 *
 * The rail is the section switcher and never changes. The sidebar changes
 * with the section - channels while you're in Chat, projects while you're in
 * Work - which is the whole point of the direction: the second level of
 * navigation gets a permanent home instead of being re-invented per page.
 *
 * Chosen in Settings > Appearance. The top bar remains the default; this
 * renders the exact same pages, so nothing below the chrome behaves
 * differently between the two.
 *
 * Two deliberate departures from the artboard, both to keep the shell native
 * to this codebase rather than a visual transplant:
 *
 *  - **Accent.** The mock hardcodes `#2B59FF`. This uses the user's chosen
 *    brand gradient instead, so the rail matches the gradient buttons on
 *    every page inside it. Structure, spacing and neutrals are the mock's.
 *  - **Icons.** The mock uses geometric glyphs (◉ ✉ ▦). Those render
 *    inconsistently across Windows and Android, and the rest of the app is
 *    lucide throughout - so lucide at the mock's 15px glyph size.
 *
 * Sidebar contents are wired to real data where the app has it (chat rooms
 * with live unread counts, projects). Sections whose sub-navigation does not
 * exist as a route yet link to the section root rather than inventing deep
 * links that would 404.
 */

/* The mock's neutral palette, kept exactly. Only the accent is remapped. */
const RAIL_BG = '#14161A';
const PANEL_BG = '#1B1E24';
const HAIRLINE = 'rgba(255,255,255,.06)';

type Section =
  | 'home'
  | 'dashboard'
  | 'mail'
  | 'chat'
  | 'projects'
  | 'leads'
  | 'financials'
  | 'time'
  | 'todo'
  | 'admin'
  | 'settings';

interface RailEntry {
  key: Section;
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Route prefixes that light this entry up, beyond `href`. */
  match?: string[];
  /** Registry id in `@/lib/nav-registry`, used for the visibility toggle. */
  prefkey?: string;
}

const RAIL: RailEntry[] = [
  { key: 'home', href: '/home', label: 'Home', icon: Home, prefkey: 'home' },
  {
    key: 'dashboard',
    href: '/dashboard',
    label: 'Dash',
    icon: LayoutDashboard,
    prefkey: 'dashboard',
  },
  { key: 'mail', href: '/mail', label: 'Mail', icon: Mail, prefkey: 'mail' },
  { key: 'chat', href: '/chat', label: 'Chat', icon: MessageSquare, prefkey: 'chat' },
  {
    key: 'projects',
    href: '/projects',
    label: 'Work',
    icon: FolderKanban,
    match: ['/projects', '/documents'],
    prefkey: 'projects',
  },
  {
    key: 'leads',
    href: '/leads',
    label: 'Leads',
    icon: UserPlus,
    match: ['/leads', '/clients'],
    prefkey: 'leads',
  },
  {
    key: 'time',
    href: '/timesheets',
    label: 'Time',
    icon: Clock,
    match: ['/timesheets', '/calendar'],
    prefkey: 'timesheets',
  },
  {
    key: 'financials',
    href: '/financials',
    label: 'Money',
    icon: Wallet,
    prefkey: 'financials',
  },
  { key: 'todo', href: '/todo', label: 'Todos', icon: CheckSquare, prefkey: 'todo' },
];

export function NavRailShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Panel collapse is a persisted preference rather than local state so it
  // survives navigation and reloads - a collapsed panel that springs back
  // open on every route change is worse than no collapse at all.
  const { navPanelCollapsed } = useAppAppearance();

  // Navigating closes the mobile drawer. Without this the overlay stays up
  // over the page the user just asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Escape closes it too - it is a modal overlay on small screens.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    // `--app-content-h`: see AppChrome. The rail puts no bar above the page
    // on lg, so a full-bleed page gets the whole viewport; below lg the 52px
    // mobile header comes off the top.
    <div className="flex h-screen overflow-hidden bg-bg-app text-ink [--app-content-h:calc(100vh-52px)] lg:[--app-content-h:100vh]">
      {/* Desktop chrome. Below lg it collapses into the drawer below, because
          68 + 250 of fixed chrome leaves nothing for the page on a phone. */}
      <div className="hidden lg:flex">
        <IconRail showBell collapsedPanel={navPanelCollapsed} />
        {/* The drawer below always renders the panel: on mobile the rail alone
            is not enough to navigate, so collapse is a desktop affordance. */}
        {navPanelCollapsed ? null : <ContextSidebar hostSlot />}
      </div>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/50"
          />
          <div className="relative flex animate-in slide-in-from-left duration-200">
            <IconRail />
            <ContextSidebar onClose={() => setDrawerOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header - the only way to reach navigation below lg. */}
        <header
          className="flex shrink-0 items-center gap-2 border-b border-line px-3 lg:hidden"
          style={{ height: 52 }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            className="grid h-9 w-9 place-items-center rounded-lg text-ink-muted hover:bg-bg-subtle hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex min-w-0 flex-1 items-center">
            <Logo size={22} />
          </span>
          <NotificationBell />
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/** Column 1 - 68px, section switcher. */
function IconRail({
  showBell = false,
  collapsedPanel = false,
}: {
  /** The mobile header already carries the bell; only the desktop rail
   *  needs its own, otherwise it is unreachable at lg and up. */
  showBell?: boolean;
  /** When the context panel is collapsed its search box and workspace
   *  switcher are gone, so the rail offers both itself. */
  collapsedPanel?: boolean;
} = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSessionContext();
  const user = session.data?.user;
  const nav = useNavPrefs(user?.id ?? '');
  const sales = useSalesAccess();
  // A read only support session hides Mail and Chat (the API refuses both)
  // and never subscribes the operator's own account to notifications.
  const inSupport = useActiveSupportSession() !== null;
  useDesktopNotifications(inSupport ? null : (user?.id ?? null));

  // Effective company permissions (custom roles + overrides), the same ones
  // the API enforces. Money needs company finance.*, never a workspace role.
  const perms = usePermissions();
  const isAdmin = perms.isOrgAdmin;
  const isHr = perms.isHr && !perms.isOrgAdmin;
  const isFinance = perms.isFinance && !perms.isOrgAdmin;
  const { navPanelCollapsed } = useAppAppearance();

  // Live unread, straight off the rooms query GlobalRealtime already keeps
  // warm - so the badge costs nothing extra and moves the moment a message
  // lands, same as the sidebar badge in the top-bar shell.
  const signOut = useRailSignOut();

  const rooms = useChatRooms();
  const chatUnread = useMemo(
    () => (rooms.data?.items ?? []).reduce((acc, r) => acc + (r.unreadCount ?? 0), 0),
    [rooms.data],
  );

  const roleVisible: Record<string, boolean> = {
    leads: sales.leads,
    financials: isAdmin || isFinance,
    ...(inSupport ? { mail: false, chat: false } : {}),
  };
  const entries = RAIL.filter(
    (r) =>
      (!r.prefkey || nav.isVisible(r.prefkey)) && (roleVisible[r.key] ?? true),
  );

  const active = (r: RailEntry): boolean =>
    matchesSection(pathname, r.href, r.match);

  return (
    <nav
      aria-label="Sections"
      className="flex w-[68px] shrink-0 flex-col items-center gap-[3px] overflow-y-auto pb-3 pt-3.5"
      style={{ background: RAIL_BG }}
    >
      {/* The brand mark, not a letter. `logo-icon.svg` is the hexagon alone,
          which is what fits a 34px square - the wordmark would be illegible
          at this width. The top bar uses the full wordmark for the same
          reason in reverse. */}
      <Link
        href="/home"
        aria-label="Home"
        className="mb-2.5 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Logo variant="icon" size={30} />
      </Link>

      {entries.map((r) => (
        <RailItem
          key={r.key}
          href={r.href}
          label={r.label}
          icon={r.icon}
          active={active(r)}
          badge={r.key === 'chat' ? chatUnread : 0}
        />
      ))}

      {isAdmin && nav.isVisible('admin') ? (
        <RailItem
          href="/admin"
          label="Admin"
          icon={ShieldCheck}
          active={matchesSection(pathname, '/admin')}
          badge={0}
        />
      ) : null}
      {isHr ? (
        <RailItem
          href="/admin/attendance"
          label="HR"
          icon={UserCog}
          active={matchesSection(pathname, '/admin')}
          badge={0}
        />
      ) : null}

      <div className="flex-1" />

      {collapsedPanel ? (
        <>
          <RailButton label="Search (Ctrl+K)" icon={Search} onClick={openCommandPalette} />
          <RailButton
            label="Switch workspace"
            icon={ArrowLeftRight}
            onClick={() => router.push('/select-workspace')}
          />
        </>
      ) : null}

      {showBell ? <NotificationBell variant="rail" /> : null}

      <Link
        href="/download"
        aria-label="Download desktop app"
        title="Download desktop app"
        aria-current={matchesSection(pathname, '/download') ? 'page' : undefined}
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
          matchesSection(pathname, '/download')
            ? 'bg-brand-gradient-soft text-white'
            : 'text-[#8A919D] hover:bg-white/[0.07] hover:text-[#C9CDD6]',
        )}
      >
        <Download className="h-4 w-4" />
      </Link>

      <button
        type="button"
        onClick={() =>
          setAppAppearance({ navPanelCollapsed: !navPanelCollapsed })
        }
        aria-label={navPanelCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={navPanelCollapsed}
        title={navPanelCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="mb-1 hidden h-8 w-8 shrink-0 place-items-center rounded-lg text-[#6B7280] transition-colors hover:bg-white/[0.07] hover:text-[#A7AEBA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 lg:grid"
      >
        {navPanelCollapsed ? (
          <PanelLeftOpen className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>

      <button
        type="button"
        onClick={() => void signOut()}
        aria-label="Sign out"
        title="Sign out"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#6B7280] transition-colors hover:bg-white/[0.07] hover:text-[#FF4D3D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <LogOut className="h-4 w-4" />
      </button>

      <Link
        href="/settings"
        aria-label="Your account"
        title={user?.name || user?.email || 'Account'}
        className="mt-2 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <UserAvatar
          name={user?.name || user?.email || ''}
          image={user?.image ?? null}
          size="sm"
          className="ring-2 ring-[#3A404B]"
        />
      </Link>
    </nav>
  );
}

function RailButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: ComponentType<{ className?: string }>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#8A919D] transition-colors hover:bg-white/[0.07] hover:text-[#C9CDD6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function RailItem({
  href,
  label,
  icon: Icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  active: boolean;
  badge: number;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex w-[54px] shrink-0 flex-col items-center gap-1 rounded-[9px] py-[7px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
        active
          ? 'bg-brand-gradient-soft text-white'
          : 'text-[#8A919D] hover:bg-white/[0.07] hover:text-[#C9CDD6]',
      )}
    >
      <Icon className="h-[15px] w-[15px]" />
      <span className="max-w-full truncate text-[9px] font-bold tracking-[0.2px]">{label}</span>
      {badge > 0 ? (
        <span className="absolute right-2 top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg bg-[#FF4D3D] px-1 text-[9px] font-bold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </Link>
  );
}

/** Column 2 - 250px, contextual to the active section. */
function ContextSidebar({
  onClose,
  hostSlot = false,
}: {
  onClose?: () => void;
  /** Only the desktop panel hosts the feature-sidebar slot - see
   *  {@link NavPanelOutlet} on why a second outlet would steal it. */
  hostSlot?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const workspace = useCurrentWorkspace();
  const connected = useSocketConnected();
  const section = sectionFor(pathname);
  const claimed = useNavPanelClaimed() && hostSlot;

  return (
    <div
      className={cn(
        'relative flex shrink-0 flex-col',
        // A feature sidebar (chat rooms, mail folders) carries avatars,
        // timestamps and previews; 250px was sized for plain link lists.
        claimed ? 'w-[300px]' : 'w-[250px]',
      )}
      style={{ background: PANEL_BG }}
    >
      {/* Workspace switcher */}
      <button
        type="button"
        onClick={() => router.push('/select-workspace')}
        className="flex h-[52px] shrink-0 items-center gap-[9px] px-3.5 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40"
        style={{ borderBottom: `1px solid ${HAIRLINE}` }}
      >
        <span className="h-[22px] w-[22px] shrink-0 rounded-md border border-white/[0.12] bg-[#343B45]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-[#F2F4F7]">
            {workspace.data?.name ?? 'Workspace'}
          </span>
          <span className="block truncate text-[10.5px] font-medium text-[#7C838F]">
            Switch workspace
          </span>
        </span>
        <ChevronDown className="h-3 w-3 shrink-0 text-[#6B7280]" />
      </button>

      {/* Search - opens the existing command palette rather than a second
          search surface. Cmd+K already does this app-wide; this is the
          discoverable affordance for it. */}
      <div className="px-3 pb-1.5 pt-2.5">
        <button
          type="button"
          onClick={openCommandPalette}
          className="flex h-[30px] w-full items-center gap-[7px] rounded-[7px] bg-white/[0.06] px-[9px] text-xs text-[#8A919D] transition-colors hover:bg-white/[0.09] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <Search className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-left">Search or jump to</span>
          <kbd className="rounded bg-white/[0.08] px-1 py-0.5 font-mono text-[9.5px]">
            ⌘K
          </kbd>
        </button>
      </div>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md text-[#8A919D] hover:bg-white/10 lg:hidden"
        >
          <X className="h-4 w-4" />
        </button>
      ) : (
        /* Collapse from the panel itself. The rail's toggle can re-open it,
           but nobody looks at the far edge of a 68px strip to close the
           thing they are pointing at. */
        <button
          type="button"
          onClick={() => setAppAppearance({ navPanelCollapsed: true })}
          aria-label="Collapse sidebar"
          title="Collapse sidebar"
          className="absolute right-2 top-[13px] hidden h-7 w-7 place-items-center rounded-md text-[#8A919D] transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 lg:grid"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      )}

      {/* The slot a feature page can fill with its real sidebar. Kept
          outside the padded container below because a feature sidebar brings
          its own chrome (search field, header row, compose button) and should
          own the full width. */}
      {hostSlot ? (
        <NavPanelOutlet className="flex min-h-0 flex-1 flex-col overflow-hidden empty:hidden" />
      ) : null}

      {claimed ? null : (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-1">
          {/* One component per section rather than one hook that fetches for
              all of them: this way the projects query only mounts while the
              user is actually in Work, instead of on every page. */}
          {section === 'chat' ? (
            <ChatGroups />
          ) : section === 'projects' ? (
            <ProjectGroups />
          ) : (
            <GroupList groups={staticGroups(section)} />
          )}
        </div>
      )}

      <div
        className="flex shrink-0 items-center gap-2 px-3 py-2.5"
        style={{ borderTop: `1px solid ${HAIRLINE}` }}
      >
        <span
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            connected ? 'animate-pulse bg-[#35E0A1]' : 'bg-[#F4845F]',
          )}
          aria-hidden
        />
        <span className="flex-1 truncate text-[11px] text-[#8A919D]">
          {connected ? 'Connected' : 'Reconnecting...'}
        </span>
        <Link
          href="/settings"
          aria-label="Settings"
          className="grid h-6 w-6 place-items-center rounded text-[#6B7280] hover:bg-white/10 hover:text-[#A7AEBA]"
        >
          <Settings className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}

interface SidebarLink {
  label: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
  meta?: string;
  /** Renders the meta pill in alert red - used for unread counts. */
  hot?: boolean;
  /** Match the pathname exactly rather than by prefix. */
  exact?: boolean;
  /**
   * For sections whose sub-navigation is query-driven rather than routed
   * (Financials uses `?tab=`), the tab this link selects. Without this every
   * `/financials?tab=x` link would match by prefix and the whole group would
   * render active at once.
   */
  tab?: string;
  /** This link is also active when the tab param is absent entirely. */
  tabIsDefault?: boolean;
}

function SidebarItem({
  label,
  href,
  icon: Icon,
  meta,
  hot,
  active,
}: SidebarLink & { active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-[29px] items-center gap-[9px] rounded-md px-2 text-[12.5px] transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/40',
        active
          ? 'bg-brand-gradient font-bold text-white'
          : 'font-medium text-[#A7AEBA] hover:bg-white/[0.055]',
      )}
    >
      <span className="grid w-3.5 shrink-0 place-items-center opacity-75">
        {Icon ? <Icon className="h-[11px] w-[11px]" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? (
        <span
          className={cn(
            'shrink-0 rounded-[9px] px-[5px] py-px text-[10px] font-bold',
            hot ? 'bg-[#FF4D3D] text-white' : 'bg-white/10 text-[#A7AEBA]',
          )}
        >
          {meta}
        </span>
      ) : null}
    </Link>
  );
}

interface SidebarGroup {
  title: string;
  items: SidebarLink[];
  /** Shown instead of the list when `items` is empty and not loading. */
  empty: string;
  /** Renders the loader instead of `empty` while the list is still loading. */
  loading?: boolean;
}

/** Renders a list of groups. Shared by every section. */
function GroupList({ groups }: { groups: SidebarGroup[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get('tab');
  return (
    <>
      {groups.map((g) => (
        <div key={g.title} className="mb-3.5">
          <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-[0.7px] text-[#6B7280]">
            {g.title}
          </div>
          {g.items.length === 0 ? (
            g.loading ? (
              <div className="px-2 py-1">
                <Loader size="xs" label="Loading" />
              </div>
            ) : (
              <p className="px-2 py-1 text-[11.5px] text-[#6B7280]">{g.empty}</p>
            )
          ) : (
            g.items.map((it) => (
              <SidebarItem
                key={it.href + it.label}
                {...it}
                active={
                  it.tab != null
                    ? pathname === it.href.split('?')[0] &&
                      (currentTab === it.tab ||
                        (currentTab == null && it.tabIsDefault === true))
                    : it.exact
                      ? pathname === it.href.split('?')[0]
                      : matchesSection(pathname, it.href)
                }
              />
            ))
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Chat sidebar - the real room list with live unread counts. `useChatRooms`
 * is already mounted app-wide by GlobalRealtime, so this is a cache read and
 * the badges move the instant a message lands.
 */
function ChatGroups() {
  const session = useSessionContext();
  const userId = session.data?.user?.id ?? '';
  const rooms = useChatRooms();

  const groups = useMemo<SidebarGroup[]>(() => {
    const all = rooms.data?.items ?? [];
    const toLink = (r: (typeof all)[number]): SidebarLink => ({
      label: roomTitle(r, userId),
      href: `/chat/${r.id}`,
      icon: r.type === 'TEXT_CHANNEL' ? Hash : MessageSquare,
      ...(r.unreadCount > 0
        ? { meta: r.unreadCount > 99 ? '99+' : String(r.unreadCount), hot: true }
        : {}),
      exact: true,
    });
    const isChannel = (r: (typeof all)[number]) =>
      r.type === 'TEXT_CHANNEL' || r.type === 'VOICE_CHANNEL';
    return [
      {
        title: 'Channels',
        items: all.filter(isChannel).map(toLink),
        loading: rooms.isLoading,
        empty: rooms.isError ? "Couldn't load channels." : 'No channels yet.',
      },
      {
        title: 'Direct messages',
        items: all.filter((r) => !isChannel(r)).map(toLink),
        loading: rooms.isLoading,
        empty: rooms.isError ? "Couldn't load conversations." : 'No conversations yet.',
      },
    ];
  }, [rooms.data, rooms.isLoading, rooms.isError, userId]);

  return <GroupList groups={groups} />;
}

/** Work sidebar - the real project list, deep-linked to each board. */
function ProjectGroups() {
  const projects = useProjects({ pageSize: 50, sort: 'name', order: 'asc' });

  const groups = useMemo<SidebarGroup[]>(
    () => [
      {
        title: 'Projects',
        items: (projects.data?.items ?? []).map((p) => ({
          label: p.name,
          href: `/projects/${p.id}`,
          icon: FolderKanban,
        })),
        loading: projects.isLoading,
        empty: projects.isError ? "Couldn't load projects." : 'No projects yet.',
      },
      {
        title: 'Library',
        items: [
          { label: 'All projects', href: '/projects', icon: FolderKanban, exact: true },
          { label: 'Documents', href: '/documents', icon: FileText },
        ],
        empty: '',
      },
    ],
    [projects.data, projects.isLoading, projects.isError],
  );

  return <GroupList groups={groups} />;
}

/**
 * Sections without their own record list. These link to routes that exist -
 * anything the app has no route for is left out rather than stubbed, so no
 * sidebar entry can 404.
 */
function staticGroups(section: Section): SidebarGroup[] {
  if (section === 'leads') {
    return [
      {
        title: 'Pipeline',
        items: [
          { label: 'Leads', href: '/leads', icon: UserPlus },
          { label: 'Clients', href: '/clients', icon: Users },
        ],
        empty: '',
      },
    ];
  }
  if (section === 'financials') {
    // Query-driven rather than routed: /financials owns its own `?tab=`
    // switcher, so these mirror it and are matched on the tab param.
    const tab = (t: string) => `/financials?tab=${t}`;
    return [
      {
        title: 'Money',
        items: [
          {
            label: 'Overview',
            href: '/financials',
            icon: LayoutDashboard,
            tab: 'overview',
            tabIsDefault: true,
          },
          { label: 'Contracts', href: tab('contracts'), icon: ScrollText, tab: 'contracts' },
          { label: 'Payments', href: tab('payments'), icon: Wallet, tab: 'payments' },
          { label: 'Expenses', href: tab('expenses'), icon: Receipt, tab: 'expenses' },
          { label: 'Invoices', href: tab('invoices'), icon: FileText, tab: 'invoices' },
        ],
        empty: '',
      },
      {
        title: 'Setup',
        items: [
          { label: 'Payment sources', href: tab('sources'), icon: Wallet, tab: 'sources' },
        ],
        empty: '',
      },
    ];
  }
  if (section === 'time') {
    return [
      {
        title: 'Time',
        items: [
          { label: 'Timesheets', href: '/timesheets', icon: Clock, exact: true },
          { label: 'Time off', href: '/timesheets/leave', icon: CalendarRange },
          { label: 'Calendar', href: '/calendar', icon: CalendarDays },
        ],
        empty: '',
      },
    ];
  }
  if (section === 'mail') {
    // Desktop no longer reaches this: /mail portals its real folder list into
    // the panel slot. This is the mobile-drawer fallback, where the slot is
    // deliberately not hosted. Folder selection is page state rather than a
    // route, so a single honest entry beats fake links that would not route.
    return [
      {
        title: 'Mail',
        items: [{ label: 'Inbox', href: '/mail', icon: Mail, exact: true }],
        empty: '',
      },
    ];
  }
  // Home, Dashboard, Todos, Settings, Admin and anything else: the app's real
  // top-level destinations.
  return [
    {
      title: 'Today',
      items: [
        { label: 'Home', href: '/home', icon: Home, exact: true },
        { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
        { label: 'Todos', href: '/todo', icon: CheckSquare },
        { label: 'Calendar', href: '/calendar', icon: CalendarDays },
      ],
      empty: '',
    },
    {
      title: 'Workspace',
      items: [
        { label: 'Projects', href: '/projects', icon: FolderKanban, exact: true },
        { label: 'Documents', href: '/documents', icon: FileText },
        { label: 'Timesheets', href: '/timesheets', icon: Clock },
      ],
      empty: '',
    },
  ];
}

/** Live socket state for the footer dot. Real connection, not a fake clock. */
function useSocketConnected(): boolean {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const socket = getChatSocket();
    setConnected(socket.connected);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);
  return connected;
}

function openCommandPalette(): void {
  // The palette listens for Cmd/Ctrl+K globally; synthesising the event keeps
  // one owner of that behaviour instead of exporting an imperative handle.
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
  );
}

function matchesSection(
  pathname: string | null,
  href: string,
  extra?: string[],
): boolean {
  if (!pathname) return false;
  const candidates = [href, ...(extra ?? [])];
  return candidates.some((c) =>
    c === '/home' ? pathname === '/home' : pathname.startsWith(c),
  );
}

function sectionFor(pathname: string | null): Section {
  if (!pathname) return 'home';
  if (pathname.startsWith('/chat')) return 'chat';
  if (pathname.startsWith('/mail')) return 'mail';
  if (pathname.startsWith('/projects') || pathname.startsWith('/documents')) {
    return 'projects';
  }
  if (pathname.startsWith('/leads') || pathname.startsWith('/clients')) return 'leads';
  if (pathname.startsWith('/financials')) return 'financials';
  if (pathname.startsWith('/timesheets') || pathname.startsWith('/calendar')) {
    return 'time';
  }
  if (pathname.startsWith('/todo')) return 'todo';
  if (pathname.startsWith('/admin')) return 'admin';
  if (pathname.startsWith('/settings')) return 'settings';
  if (pathname.startsWith('/dashboard')) return 'dashboard';
  return 'home';
}

/**
 * Sign-out with the same teardown the top bar does: drop this device's native
 * push registration, end the session, then wipe the query cache and the
 * localStorage notification mirror so signing in as someone else on the same
 * browser cannot surface the previous user's data.
 */
function useRailSignOut() {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await unregisterNativePush();
    await authClient.signOut();
    queryClient.clear();
    clearAllInAppNotifications();
    clearAppAppearance();
    router.replace('/sign-in');
    router.refresh();
  }, [router, queryClient]);
}
