import {
  CalendarDays,
  CheckSquare,
  Clock,
  FileText,
  FolderKanban,
  Home,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Settings,
  ShieldCheck,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

/**
 * The single registry of navigable destinations.
 *
 * ## Why this exists
 *
 * There were two competing navigation systems with two preference stores:
 * `use-navbar-prefs` gated the top-bar pills (and, via `prefkey`, the rail
 * icons), while the rail's `RAIL` array and the panel's `staticGroups` each
 * hardcoded their own list. Adding a destination meant editing three places,
 * and the panel could not be customised at all - which is what the user hit
 * when Financials appeared in the settings list but not in the rail.
 *
 * Every surface now filters this one list. A destination added here shows up
 * in the rail, the panel, the top bar and the settings screen at once, with
 * one role gate and one preference key.
 */

/** Where a destination is allowed to appear. */
export type NavSurface = 'rail' | 'panel' | 'topbar';

/**
 * Who may see it. Resolved by `resolveNavGate` against the session, because
 * two of these (leads/clients) need a server answer - a user can be assigned
 * individual records without holding a sales role.
 */
export type NavGate =
  | 'always'
  | 'admin'
  | 'adminOrFinance'
  | 'salesLeads'
  | 'salesClients';

/** Grouping used by the settings screen and the panel's static lists. */
export type NavGroup = 'primary' | 'workspace' | 'money' | 'admin';

export interface NavDestination {
  /** Stable preference key. Never renumber or reuse - stored per user. */
  id: string;
  label: string;
  /** One line, shown in Settings so a toggle is not a mystery. */
  description: string;
  href: string;
  icon: LucideIcon;
  surfaces: readonly NavSurface[];
  gate: NavGate;
  group: NavGroup;
  /** Chord from `GlobalHotkeys`, surfaced in Settings so it is discoverable. */
  shortcut?: string;
  /**
   * Cannot be hidden. Reserved for the escape hatches: Home is the anchor
   * route, and Settings is how you get back to this screen to undo a mistake.
   */
  alwaysOn?: boolean;
  /** Extra route prefixes that count as "you are here". */
  match?: readonly string[];
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  {
    id: 'home',
    label: 'Home',
    description: 'Navigation hub and your day at a glance.',
    href: '/home',
    icon: Home,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'primary',
    alwaysOn: true,
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Customisable widget board.',
    href: '/dashboard',
    icon: LayoutDashboard,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'primary',
    shortcut: 'g d',
    alwaysOn: true,
  },
  {
    id: 'mail',
    label: 'Mail',
    description: 'IMAP / SMTP mailbox.',
    href: '/mail',
    icon: Mail,
    surfaces: ['rail', 'topbar'],
    gate: 'always',
    group: 'primary',
    shortcut: 'g m',
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Channels, direct messages and calls.',
    href: '/chat',
    icon: MessageSquare,
    surfaces: ['rail', 'topbar'],
    gate: 'always',
    group: 'primary',
  },
  {
    id: 'todo',
    label: 'Todos',
    description: 'Your personal task list.',
    href: '/todo',
    icon: CheckSquare,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'primary',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Unified schedule across projects and leave.',
    href: '/calendar',
    icon: CalendarDays,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'primary',
  },

  {
    id: 'projects',
    label: 'Projects',
    description: 'Boards, sprints, tasks.',
    href: '/projects',
    icon: FolderKanban,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'workspace',
    shortcut: 'g p',
  },
  {
    id: 'documents',
    label: 'Documents',
    description: 'Shared docs and templates.',
    href: '/documents',
    icon: FileText,
    surfaces: ['panel', 'topbar'],
    gate: 'always',
    group: 'workspace',
    shortcut: 'g o',
  },
  {
    id: 'timesheets',
    label: 'Timesheets',
    description: 'Track and review time.',
    href: '/timesheets',
    icon: Clock,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'always',
    group: 'workspace',
  },
  {
    id: 'leads',
    label: 'Leads',
    description: 'Sales pipeline.',
    href: '/leads',
    icon: UserPlus,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'salesLeads',
    group: 'workspace',
    shortcut: 'g l',
  },
  {
    id: 'clients',
    label: 'Clients',
    description: 'Client records and their projects.',
    href: '/clients',
    icon: Users,
    surfaces: ['panel', 'topbar'],
    gate: 'salesClients',
    group: 'workspace',
    shortcut: 'g c',
  },

  {
    id: 'financials',
    label: 'Financials',
    description: 'Contracts, payments, expenses. Finance and admin only.',
    href: '/financials',
    icon: Wallet,
    surfaces: ['rail', 'panel', 'topbar'],
    gate: 'adminOrFinance',
    group: 'money',
  },

  {
    id: 'admin',
    label: 'Admin',
    description: 'Organisation, workspaces, audit log.',
    href: '/admin',
    icon: ShieldCheck,
    surfaces: ['rail', 'topbar'],
    gate: 'admin',
    group: 'admin',
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Your account and workspace settings.',
    href: '/settings',
    icon: Settings,
    surfaces: ['topbar'],
    gate: 'always',
    group: 'admin',
    shortcut: 'g s',
    alwaysOn: true,
  },
];

export const NAV_GROUP_LABEL: Record<NavGroup, string> = {
  primary: 'Everyday',
  workspace: 'Workspace',
  money: 'Money',
  admin: 'Administration',
};

export interface NavAccess {
  systemRole?: string | null;
  /** From `useSalesAccess()` - the server owns row-level assignment. */
  salesLeads: boolean;
  salesClients: boolean;
  /** Effective company permissions. When given they decide the admin and
   *  finance gates instead of `systemRole`. */
  companyPermissions?: readonly string[];
}

/**
 * Whether this user can reach a destination at all. Separate from preferences:
 * a hidden item is a choice, an ungated one is not offered in the first place.
 *
 * Mirrors the server. `adminOrFinance` matches `hasFinanceAccess` in
 * `@botss/auth` - deliberately org-level systemRole, so a workspace OWNER who
 * is a plain employee at org level does not qualify.
 */
export function canAccessNav(dest: NavDestination, access: NavAccess): boolean {
  const role = access.systemRole ?? 'EMPLOYEE';
  const perms = access.companyPermissions;
  const isAdmin = perms ? perms.includes('workspaces.admin_all') : role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isFinance = perms
    ? perms.includes('finance.view') || perms.includes('finance.manage')
    : role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'FINANCE';
  switch (dest.gate) {
    case 'always':
      return true;
    case 'admin':
      return isAdmin;
    case 'adminOrFinance':
      return isAdmin || isFinance;
    case 'salesLeads':
      return access.salesLeads;
    case 'salesClients':
      return access.salesClients;
    default:
      return true;
  }
}

/** Destinations this user can reach, in registry order. */
export function accessibleNav(access: NavAccess): NavDestination[] {
  return NAV_DESTINATIONS.filter((d) => canAccessNav(d, access));
}

export function navById(id: string): NavDestination | undefined {
  return NAV_DESTINATIONS.find((d) => d.id === id);
}
