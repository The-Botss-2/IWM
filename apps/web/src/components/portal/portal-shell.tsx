'use client';

import {
  Check,
  ChevronDown,
  FileSignature,
  FileText,
  FolderKanban,
  LayoutDashboard,
  LogOut,
  UserRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PortalClientSummary, PortalMe } from '@botss/shared-types';

import { usePortalActiveClient, usePortalMe } from '@/components/portal/portal-context';
import { UserAvatar } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  PORTAL_ACCOUNT_HREF,
  portalHref,
  portalSwitchHref,
  usePortalLocation,
  usePortalNav,
  usePortalSignOut,
  type PortalNavItem,
  type PortalSection,
} from '@/hooks/use-portal';
import { cn } from '@/lib/utils';

const SECTION_ICON: Record<PortalSection, LucideIcon> = {
  overview: LayoutDashboard,
  projects: FolderKanban,
  documents: FileText,
  signatures: FileSignature,
  billing: Wallet,
};

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-purple/50';

const MENU_ITEM = cn(
  'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-bg-subtle',
  FOCUS_RING,
);

/**
 * Chrome for the client portal: the agency's mark, the client being viewed
 * (a switcher when the person reaches more than one), section tabs and the
 * account menu. The tabs scroll sideways on narrow screens, which is how the
 * mobile app's WebView shows them.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const me = usePortalMe();
  const client = usePortalActiveClient();
  const nav = usePortalNav(client);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#portal-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-bg-surface focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-ink focus:shadow-popover"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          {client ? (
            <Link href={portalHref(client.id)} className={cn('shrink-0 rounded-md', FOCUS_RING)}>
              <AgencyMark key={client.agency.logoUrl ?? 'text'} agency={client.agency} />
            </Link>
          ) : null}
          {client ? <span aria-hidden className="h-5 w-px shrink-0 bg-line" /> : null}
          {client && me.clients.length > 1 ? (
            <ClientSwitcher clients={me.clients} active={client} />
          ) : client ? (
            <span className="min-w-0 truncate text-sm font-medium text-ink">{client.name}</span>
          ) : null}
          <div className="ml-auto shrink-0">
            <AccountMenu user={me.user} />
          </div>
        </div>
        <PortalNav items={nav} />
      </header>

      <main
        id="portal-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 focus:outline-none sm:px-6 sm:py-8"
      >
        {children}
      </main>
    </div>
  );
}

/** The agency's logo, or its name when there is no logo or it fails to load. */
function AgencyMark({ agency }: { agency: PortalClientSummary['agency'] }) {
  const [failed, setFailed] = useState(false);
  if (agency.logoUrl && !failed) {
    return (
      // Agency logos live on whichever storage host the organization uses;
      // next/image would need every such host allowlisted up front.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={agency.logoUrl}
        alt={agency.name}
        onError={() => setFailed(true)}
        className="block h-7 w-auto max-w-[7.5rem] object-contain sm:max-w-[10rem]"
      />
    );
  }
  return (
    <span className="block max-w-[7.5rem] truncate text-sm font-semibold text-ink sm:max-w-[12rem]">
      {agency.name}
    </span>
  );
}

function ClientSwitcher({
  clients,
  active,
}: {
  clients: PortalClientSummary[];
  active: PortalClientSummary;
}) {
  const [open, setOpen] = useState(false);
  const location = usePortalLocation();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${active.name}, switch client`}
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-bg-subtle',
            FOCUS_RING,
          )}
        >
          <span className="truncate">{active.name}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 max-w-[calc(100vw-2rem)]">
        <p className="px-3 pb-1.5 pt-1 text-xs font-medium text-ink-muted">Switch client</p>
        <ul>
          {clients.map((c) => {
            const current = c.id === active.id;
            return (
              <li key={c.id}>
                <Link
                  href={portalSwitchHref(c, location)}
                  onClick={() => setOpen(false)}
                  aria-current={current ? 'true' : undefined}
                  className={cn(MENU_ITEM, current && 'font-medium')}
                >
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {current ? <Check className="h-4 w-4 shrink-0 text-brand-purple" aria-hidden /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function PortalNav({ items }: { items: PortalNavItem[] }) {
  const activeRef = useRef<HTMLAnchorElement>(null);
  const activeHref = items.find((i) => i.active)?.href;

  // On a narrow screen the current tab can sit off to the side; bring it
  // into view whenever the section changes.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeHref]);

  if (items.length === 0) return null;
  return (
    <nav aria-label="Portal sections" className="mx-auto max-w-6xl px-2 sm:px-4">
      <ul className="flex items-center gap-1 overflow-x-auto">
        {items.map((item) => {
          const Icon = SECTION_ICON[item.section];
          return (
            <li key={item.section} className="shrink-0">
              <Link
                ref={item.active ? activeRef : undefined}
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                className={cn(
                  'relative inline-flex items-center gap-2 whitespace-nowrap rounded-t-md px-3 py-2.5 text-sm font-medium transition-colors',
                  'after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-purple/50',
                  item.active
                    ? 'text-ink after:bg-brand-gradient'
                    : 'text-ink-muted after:bg-transparent hover:text-ink',
                )}
              >
                <Icon className="hidden h-4 w-4 sm:block" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function AccountMenu({ user }: { user: PortalMe['user'] }) {
  const [open, setOpen] = useState(false);
  const signOut = usePortalSignOut();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          className={cn('grid h-10 w-10 place-items-center rounded-full', FOCUS_RING)}
        >
          <UserAvatar name={user.name || user.email} size="sm" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)]">
        <div className="border-b border-line px-3 pb-2.5 pt-1.5">
          <p className="truncate text-sm font-semibold text-ink">{user.name || 'Your account'}</p>
          <p className="truncate text-xs text-ink-muted">{user.email}</p>
        </div>
        <div className="pt-1.5">
          <Link href={PORTAL_ACCOUNT_HREF} onClick={() => setOpen(false)} className={MENU_ITEM}>
            <UserRound className="h-4 w-4 text-ink-muted" aria-hidden />
            Account
          </Link>
          <button
            type="button"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
            className={cn(MENU_ITEM, 'text-state-error hover:bg-tint-error disabled:opacity-60')}
          >
            <LogOut className="h-4 w-4" aria-hidden />
            {signOut.isPending ? 'Signing out' : 'Sign out'}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
