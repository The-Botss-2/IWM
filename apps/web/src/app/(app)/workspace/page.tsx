'use client';

import {
  Briefcase,
  FileText,
  FolderKanban,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { cn } from '@/lib/utils';

interface Card {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  accent: string;
  /** Hidden unless `useSalesAccess()` grants this section. */
  salesSection?: 'leads' | 'clients';
}

const CARDS: Card[] = [
  {
    href: '/projects',
    title: 'Projects',
    description: 'Kanban boards, sprints, and the full task graph.',
    icon: FolderKanban,
    accent: 'bg-brand-50 text-brand-700',
  },
  {
    href: '/clients',
    title: 'Clients',
    description: 'Active accounts and the projects attached to them.',
    icon: Users,
    accent: 'bg-tint-info text-brand-teal',
    salesSection: 'clients',
  },
  {
    href: '/leads',
    title: 'Leads',
    description: 'Opportunities in the pipeline before they convert.',
    icon: Briefcase,
    accent: 'bg-tint-warning text-brand-orange',
    salesSection: 'leads',
  },
  {
    href: '/documents',
    title: 'Documents',
    description: 'Shared notes, runbooks, and Tiptap content.',
    icon: FileText,
    accent: 'bg-[#FAEBFE] text-brand-magenta',
  },
];

/**
 * Landing page that the user sees right after picking a workspace at
 * `/select-workspace`. Focused: four entity entry-points. From here they
 * either dive in, or jump back to `/home` for the broader app grid.
 */
export default function WorkspaceLandingPage() {
  const workspace = useCurrentWorkspace();
  // Leads and Clients are gated independently - being assigned a client
  // shouldn't surface the Leads card too.
  const sales = useSalesAccess();
  const cards = CARDS.filter((c) => !c.salesSection || sales[c.salesSection]);
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink-muted">
            Now in {workspace.data?.name ?? 'your workspace'}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-ink sm:text-3xl">
            What do you want to open?
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Pick one of the core workspace surfaces below, or head{' '}
            <Link href="/home" className="text-brand-700 underline">
              home
            </Link>{' '}
            for everything else.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" asChild>
            <Link href="/select-workspace">Switch workspace</Link>
          </Button>
          <Button variant="ghost" asChild>
            <Link href="/home">Home</Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.href}
              href={c.href}
              className={cn(
                'group flex items-start gap-4 rounded-xl border border-line bg-white p-6 transition',
                'hover:-translate-y-0.5 hover:border-brand-purple/40 hover:shadow-md',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
              )}
            >
              <span className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-lg', c.accent)}>
                <Icon className="h-6 w-6" />
              </span>
              <span className="min-w-0">
                <span className="block text-lg font-semibold text-ink">{c.title}</span>
                <span className="mt-0.5 block text-sm text-ink-muted">{c.description}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
