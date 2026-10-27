'use client';

import {
  Briefcase,
  CalendarDays,
  Clock,
  FileText,
  FolderKanban,
  LayoutDashboard,
  ListTodo,
  Mail,
  MessageSquare,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { useSessionContext } from '@/components/auth/session-gate';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { cn } from '@/lib/utils';

interface AppTile {
  id?: string;
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accentClass: string;
  iconClass: string;
  /** Hidden unless `useSalesAccess()` grants this section (`leads`/`clients`). */
  salesSection?: 'leads' | 'clients';
}

const APPS: AppTile[] = [
  {
    id: 'workspace',
    href: '/select-workspace',
    title: 'Workspace',
    description: 'Switch tenant, then pick projects, leads, clients or docs.',
    icon: FolderKanban,
    accentClass: 'bg-brand-50',
    iconClass: 'text-brand-700',
  },
  {
    id: 'dashboard',
    href: '/dashboard',
    title: 'Dashboard',
    description: 'Your customizable widget board.',
    icon: LayoutDashboard,
    accentClass: 'bg-[#EFE9FC]',
    iconClass: 'text-brand-purple',
  },
  {
    id: 'mail',
    href: '/mail',
    title: 'Email',
    description: 'Read and send mail from any IMAP / SMTP account.',
    icon: Mail,
    accentClass: 'bg-[#EAF0FC]',
    iconClass: 'text-brand-blue',
  },
  {
    id: 'chat',
    href: '/chat',
    title: 'Communication',
    description: 'WhatsApp-style chat with calls, groups and channels.',
    icon: MessageSquare,
    accentClass: 'bg-tint-info',
    iconClass: 'text-brand-teal',
  },
  {
    id: 'todo',
    href: '/todo',
    title: 'Todos',
    description: 'Your personal task list.',
    icon: ListTodo,
    accentClass: 'bg-tint-warning',
    iconClass: 'text-brand-orange',
  },
  {
    id: 'timesheets',
    href: '/timesheets',
    title: 'Timesheets',
    description: 'Track time across all your projects.',
    icon: Clock,
    accentClass: 'bg-tint-info',
    iconClass: 'text-brand-teal',
  },
  {
    id: 'calendar',
    href: '/calendar',
    title: 'Calendar',
    description: 'Unified view of tasks, todos, and time.',
    icon: CalendarDays,
    accentClass: 'bg-[#FAEBFE]',
    iconClass: 'text-brand-magenta',
  },
];

const SHORTCUTS: AppTile[] = [
  {
    id: 'projects',
    href: '/projects',
    title: 'Projects',
    description: 'Kanban boards and task tracking.',
    icon: FolderKanban,
    accentClass: 'bg-bg-subtle',
    iconClass: 'text-ink',
  },
  {
    id: 'leads',
    href: '/leads',
    title: 'Leads',
    description: 'Pipeline of opportunities.',
    icon: Briefcase,
    accentClass: 'bg-bg-subtle',
    iconClass: 'text-ink',
    salesSection: 'leads',
  },
  {
    id: 'clients',
    href: '/clients',
    title: 'Clients',
    description: 'Active accounts and their projects.',
    icon: Users,
    accentClass: 'bg-bg-subtle',
    iconClass: 'text-ink',
    salesSection: 'clients',
  },
  {
    id: 'documents',
    href: '/documents',
    title: 'Documents',
    description: 'Shared notes and runbooks.',
    icon: FileText,
    accentClass: 'bg-bg-subtle',
    iconClass: 'text-ink',
  },
  {
    id: 'settings',
    href: '/settings/workspace',
    title: 'Settings',
    description: 'Workspace members, branding, defaults.',
    icon: Settings,
    accentClass: 'bg-bg-subtle',
    iconClass: 'text-ink',
  },
];

/**
 * Home is the navigation hub. It does NOT host any dashboard widgets - those
 * live on `/dashboard`, which can be customized per user. Home stays
 * stable so it's predictable to navigate from.
 */
export default function HomePage() {
  const session = useSessionContext();
  const workspace = useCurrentWorkspace();
  const user = session.data?.user;

  const greeting = greetingFor(new Date());
  const firstName = user?.name?.split(' ')[0] || '';
  // Leads and Clients are gated independently - being assigned a client
  // shouldn't surface the Leads tile too.
  const sales = useSalesAccess();
  const shortcuts = SHORTCUTS.filter((s) => !s.salesSection || sales[s.salesSection]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-10">
        <p className="text-xs font-medium text-ink-muted">
          {workspace.data?.name ?? 'Your workspace'}
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-ink sm:text-3xl">
          {greeting}
          {firstName ? (
            <>
              , <span className="text-brand-gradient">{firstName}</span>
            </>
          ) : null}
          .
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Pick where you want to work.
        </p>
      </header>

      <section aria-labelledby="apps-heading" className="mb-10">
        <h2
          id="apps-heading"
          className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          Apps
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {APPS.map((app) => (
            <AppCard key={app.href} app={app} size="lg" />
          ))}
        </div>
      </section>

      <section aria-labelledby="shortcuts-heading">
        <h2
          id="shortcuts-heading"
          className="mb-4 text-xs font-semibold uppercase tracking-wide text-ink-muted"
        >
          Shortcuts
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((app) => (
            <AppCard key={app.href} app={app} size="sm" />
          ))}
        </div>
      </section>
    </div>
  );
}

function AppCard({ app, size }: { app: AppTile; size: 'lg' | 'sm' }) {
  const Icon = app.icon;
  return (
    <Link
      href={app.href}
      className={cn(
        'group flex items-start gap-3 rounded-xl bg-white shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-lg',
        'focus-visible:outline-none focus-visible:shadow-focus',
        size === 'lg' ? 'p-6' : 'p-4',
      )}
    >
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-lg bg-brand-gradient-soft',
          size === 'lg' ? 'h-12 w-12' : 'h-9 w-9',
        )}
      >
        <Icon className={cn('text-brand-purple', size === 'lg' ? 'h-5 w-5' : 'h-4 w-4')} />
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            'block font-semibold text-ink',
            size === 'lg' ? 'text-base' : 'text-sm',
          )}
        >
          {app.title}
        </span>
        <span
          className={cn(
            'mt-0.5 block text-ink-muted',
            size === 'lg' ? 'text-sm' : 'text-xs',
          )}
        >
          {app.description}
        </span>
      </span>
    </Link>
  );
}

function greetingFor(d: Date): string {
  const hour = d.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Working late';
}
