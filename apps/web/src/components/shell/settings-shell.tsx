'use client';

import {
  Compass,
  Building2,
  CalendarCheck,
  CalendarRange,
  Clock,
  FileText,
  History,
  Laptop,
  LifeBuoy,
  ListChecks,
  Mail,
  MessageSquare,
  Palette,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import type { SystemRole } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { usePermissions, type PermissionsView } from '@/hooks/use-permissions';
import { cn } from '@/lib/utils';

type Group = 'workspace' | 'admin';

interface NavItem {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  group: Group;
  /// Roles allowed to see the link. Undefined = visible to everyone with
  /// settings access. Server still enforces; this is UX hygiene so non-admins
  /// don't see (or dangle on) admin-only sections.
  gate?: Gate;
}

/** Visibility gates, on effective permissions (custom roles + overrides). */
type Gate = (p: PermissionsView, role: SystemRole | undefined) => boolean;
const ADMIN_OR_HR: Gate = (p) => p.isOrgAdmin || p.isHr || p.has('users.manage');
const ORG_SETTINGS_OR_HR: Gate = (p) => p.has('org.settings') || p.isHr;
const ORG_SETTINGS: Gate = (p) => p.has('org.settings');
const FINANCE_ROLES: Gate = (p) => p.isOrgAdmin || p.isFinance;
const ADMIN_ONLY: Gate = (p) => p.isOrgAdmin;
const AUDIT: Gate = (p) => p.has('audit.view');
const LEAVE_APPROVER: Gate = (p) => p.has('hr.leave.approve');
const ROLES: Gate = (p) => p.canManageRoles;
const ROOT_ONLY: Gate = (_p, role) => role === 'SUPER_ADMIN';

// One nav for the whole settings/admin surface. Admin tools live at /admin/*
// routes but render inside this same shell, so the sidebar never changes out
// from under the user. Gating mirrors the prior split layouts exactly.
const ITEMS: NavItem[] = [
  // Workspace group - general settings, visible to everyone.
  {
    href: '/settings/workspace',
    label: 'Workspace',
    description: 'Workspace info, members, and pending invitations.',
    icon: SettingsIcon,
    group: 'workspace',
  },
  {
    href: '/settings/appearance',
    label: 'Appearance',
    description: 'Theme, brand gradient, and accent colors.',
    icon: Palette,
    group: 'workspace',
  },
  {
    href: '/settings/navigation',
    label: 'Navigation',
    description: 'Layout, which sections you see, and keyboard shortcuts.',
    icon: Compass,
    group: 'workspace',
  },
  {
    href: '/settings/devices',
    label: 'Devices',
    description: 'Where you are signed in, and sign out of other devices.',
    icon: Laptop,
    group: 'workspace',
  },
  {
    href: '/settings/communication',
    label: 'Communication',
    description: 'Manage chat preferences, rooms, and channels.',
    icon: MessageSquare,
    group: 'workspace',
  },
  {
    href: '/settings/mail',
    label: 'Mail settings',
    description: 'Mailboxes and email signatures for the Mail tab.',
    icon: Mail,
    group: 'workspace',
  },
  {
    href: '/settings/organization-mail',
    label: 'Organization email',
    description: 'Org-wide SMTP/IMAP for invitations and mail.',
    icon: Building2,
    group: 'workspace',
    gate: ORG_SETTINGS_OR_HR,
  },
  {
    href: '/settings/invoicing',
    label: 'Invoicing',
    description: 'Company details, logo, bank details and the default invoice template.',
    icon: FileText,
    group: 'workspace',
    gate: FINANCE_ROLES,
  },
  // Admin group - org/system tools, hidden entirely from non-admins.
  {
    href: '/settings/users',
    label: 'Users',
    description: 'Create, edit, import, and remove user accounts.',
    icon: UserCog,
    group: 'admin',
    gate: ADMIN_OR_HR,
  },
  {
    href: '/settings/roles',
    label: 'Roles',
    description: 'Company and workspace roles and what each one can do.',
    icon: ShieldCheck,
    group: 'admin',
    gate: ROLES,
  },
  {
    href: '/settings/support-access',
    label: 'Support access',
    description: 'Let platform support read your organization for a limited time.',
    icon: LifeBuoy,
    group: 'admin',
    gate: ORG_SETTINGS,
  },
  {
    href: '/admin/organizations',
    label: 'Organizations',
    description: 'Tenant organizations: create, edit, suspend and delete.',
    icon: Building2,
    group: 'admin',
    gate: ROOT_ONLY,
  },
  {
    href: '/admin/platform-log',
    label: 'Platform log',
    description: 'Organization-level events across every organization.',
    icon: ScrollText,
    group: 'admin',
    gate: ROOT_ONLY,
  },
  {
    href: '/admin/workspaces',
    label: 'Workspaces',
    description: 'Every workspace inside your organization.',
    icon: Users,
    group: 'admin',
    gate: ADMIN_ONLY,
  },
  {
    href: '/admin/timesheets',
    label: 'Timesheets',
    description: 'Attendance grid + tracked time across the org.',
    icon: Clock,
    group: 'admin',
    gate: ADMIN_OR_HR,
  },
  {
    href: '/admin/attendance',
    label: 'Attendance',
    description: 'Monthly status grid + manual overrides.',
    icon: CalendarCheck,
    group: 'admin',
    gate: ADMIN_OR_HR,
  },
  {
    href: '/admin/attendance/summary',
    label: 'Attendance summary',
    description: 'Per-user combined hours + presence dashboard.',
    icon: ListChecks,
    group: 'admin',
    gate: ADMIN_OR_HR,
  },
  {
    href: '/admin/leaves',
    label: 'Leave requests',
    description: 'Approve or reject time off across the org.',
    icon: CalendarRange,
    group: 'admin',
    gate: LEAVE_APPROVER,
  },
  {
    href: '/admin/audit-log',
    label: 'Audit log',
    description: 'Sensitive changes inside your organization.',
    icon: History,
    group: 'admin',
    gate: AUDIT,
  },
];

const GROUPS: ReadonlyArray<{ key: Group; label: string }> = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'admin', label: 'Admin' },
];

function canSee(item: NavItem, perms: PermissionsView, role: SystemRole | undefined): boolean {
  if (!item.gate) return true;
  return item.gate(perms, role);
}

/**
 * Unified settings + admin shell. A single left nav (grouped, role-gated) drives
 * both /settings/* and /admin/* so navigating between them never swaps the
 * sidebar. Each admin route still enforces access server-side and via its
 * layout redirect; the role gate here only decides what's shown.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const session = useSessionContext();
  const role = session.data?.user?.systemRole;
  const perms = usePermissions();

  // Highlight the most specific matching item (so e.g. /admin/attendance/summary
  // lights "Attendance summary", not the shorter "Attendance").
  const activeHref = useMemo(() => {
    if (!pathname) return undefined;
    return ITEMS.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`)).sort(
      (a, b) => b.href.length - a.href.length,
    )[0]?.href;
  }, [pathname]);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8">
        <h1 className="text-ink text-2xl font-semibold">Settings</h1>
        <p className="text-ink-muted mt-1 text-sm">
          Manage your workspace, mailboxes, team, and admin tools.
        </p>
      </header>
      <div className="grid gap-6 md:grid-cols-[240px_minmax(0,1fr)]">
        <aside aria-label="Settings sections">
          <nav className="space-y-4" role="list">
            {GROUPS.map((group) => {
              const items = ITEMS.filter((i) => i.group === group.key && canSee(i, perms, role));
              if (items.length === 0) return null;
              return (
                <div key={group.key} className="space-y-1">
                  <p className="text-ink-muted px-4 text-[11px] font-semibold uppercase tracking-wide">
                    {group.label}
                  </p>
                  {items.map((item) => {
                    const Icon = item.icon;
                    const active = item.href === activeHref;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-start gap-2 rounded-full px-4 py-2.5 text-sm transition-all duration-200',
                          'focus-visible:shadow-focus focus-visible:outline-none',
                          active
                            ? 'bg-brand-gradient shadow-soft text-white'
                            : 'text-ink hover:bg-bg-subtle',
                        )}
                      >
                        <Icon
                          className={cn(
                            'mt-0.5 h-4 w-4 shrink-0',
                            active ? 'text-white' : 'text-ink-muted',
                          )}
                          aria-hidden
                        />
                        <span className="min-w-0">
                          <span className="block font-medium">{item.label}</span>
                          <span
                            className={cn(
                              'mt-0.5 block text-[11px]',
                              active ? 'text-white/80' : 'text-ink-muted',
                            )}
                          >
                            {item.description}
                          </span>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
