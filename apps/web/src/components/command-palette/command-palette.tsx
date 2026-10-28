'use client';

import { Command } from 'cmdk';
import {
  Briefcase,
  FileText,
  FolderKanban,
  Hash,
  Home,
  Mail,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SearchResult } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useSalesAccess } from '@/hooks/use-sales-access';
import { hasSearchModifiers } from '@/lib/search-query';

/**
 * Global Cmd+K command palette. Mounted once at the (app) layout root.
 *
 * Groups:
 *   Navigation - fixed routes
 *   Actions    - new-X creators (current step: navigation to creation surfaces)
 *   Search     - type 2+ chars to hit /api/v1/search across tasks/projects/leads/clients/docs.
 *                Text with modifiers (from: in: has: after: before:) only
 *                offers "Search everything", which opens the search page.
 *   Recent     - last 5 destinations opened from this palette (localStorage)
 *
 * Hotkeys for navigation are bound elsewhere via `use-hotkeys.ts` so they keep
 * working when the palette is closed.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  // Leads/Clients entries are hidden unless the user has that section - the
  // routes would only redirect back to /home otherwise.
  const sales = useSalesAccess();

  // Cmd/Ctrl+K opens the palette anywhere in (app)/*. Escape closes via cmdk
  // built-in behavior; we just hand off the open event.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Modifiers need the search page to resolve names to ids, so the palette
  // does not try to run them itself.
  const withModifiers = hasSearchModifiers(debouncedQuery);
  const search = useQuery({
    queryKey: ['command-search', debouncedQuery],
    queryFn: () => getApi().search.query({ q: debouncedQuery, limit: 15 }),
    enabled: open && debouncedQuery.trim().length >= 2 && !withModifiers,
    staleTime: 10_000,
  });

  const [recent, setRecent] = useState<RecentItem[]>(() => loadRecent());

  const go = useCallback(
    (item: RecentItem) => {
      pushRecent(item);
      setRecent(loadRecent());
      setOpen(false);
      setQuery('');
      router.push(item.href);
    },
    [router],
  );

  const showSearch = debouncedQuery.trim().length >= 2;

  return (
    <>
      {open ? (
        <div
          className="bg-ink/40 fixed inset-0 z-50 flex items-start justify-center pt-[15vh] backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <Command
            label="Command Menu"
            className="border-line w-full max-w-xl overflow-hidden rounded-lg border bg-white shadow-2xl"
            shouldFilter={!showSearch}
          >
            <div className="border-line flex items-center gap-2 border-b px-3">
              <Search className="text-ink-disabled h-4 w-4" aria-hidden />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Type a command or search…"
                className="placeholder:text-ink-disabled h-11 flex-1 bg-transparent text-sm outline-none"
                autoFocus
              />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="text-ink-disabled px-3 py-6 text-center text-sm">
                {showSearch && search.isFetching ? 'Searching…' : 'No results.'}
              </Command.Empty>

              {!showSearch && recent.length > 0 ? (
                <Command.Group heading="Recent">
                  {recent.map((r) => (
                    <Item key={`recent-${r.href}`} icon={iconFor(r.kind)} onSelect={() => go(r)}>
                      {r.title}
                      {r.context ? (
                        <span className="text-ink-disabled ml-auto text-xs">{r.context}</span>
                      ) : null}
                    </Item>
                  ))}
                </Command.Group>
              ) : null}

              {!showSearch ? (
                <>
                  <Command.Group heading="Navigation">
                    <Item
                      icon={<Home className="h-4 w-4" />}
                      onSelect={() => go({ kind: 'nav', title: 'Dashboard', href: '/dashboard' })}
                      shortcut="G D"
                    >
                      Go to Dashboard
                    </Item>
                    <Item
                      icon={<FolderKanban className="h-4 w-4" />}
                      onSelect={() => go({ kind: 'nav', title: 'Projects', href: '/projects' })}
                      shortcut="G P"
                    >
                      Go to Projects
                    </Item>
                    {sales.leads ? (
                      <Item
                        icon={<Users className="h-4 w-4" />}
                        onSelect={() => go({ kind: 'nav', title: 'Leads', href: '/leads' })}
                        shortcut="G L"
                      >
                        Go to Leads
                      </Item>
                    ) : null}
                    {sales.clients ? (
                      <Item
                        icon={<Briefcase className="h-4 w-4" />}
                        onSelect={() => go({ kind: 'nav', title: 'Clients', href: '/clients' })}
                        shortcut="G C"
                      >
                        Go to Clients
                      </Item>
                    ) : null}
                    <Item
                      icon={<FileText className="h-4 w-4" />}
                      onSelect={() => go({ kind: 'nav', title: 'Documents', href: '/documents' })}
                      shortcut="G O"
                    >
                      Go to Documents
                    </Item>
                    <Item
                      icon={<Mail className="h-4 w-4" />}
                      onSelect={() => go({ kind: 'nav', title: 'Mail', href: '/mail' })}
                    >
                      Go to Mail
                    </Item>
                    <Item
                      icon={<Settings className="h-4 w-4" />}
                      onSelect={() => go({ kind: 'nav', title: 'Settings', href: '/settings' })}
                    >
                      Go to Settings
                    </Item>
                  </Command.Group>

                  <Command.Group heading="Actions">
                    <Item
                      icon={<Plus className="h-4 w-4" />}
                      onSelect={() =>
                        go({ kind: 'nav', title: 'New Project', href: '/projects?new=1' })
                      }
                    >
                      New Project
                    </Item>
                    {/* Creating is reserved for full sales access; someone who
                        only has records assigned to them can't make new ones. */}
                    {sales.fullAccess ? (
                      <>
                        <Item
                          icon={<Plus className="h-4 w-4" />}
                          onSelect={() =>
                            go({ kind: 'nav', title: 'New Lead', href: '/leads?new=1' })
                          }
                        >
                          New Lead
                        </Item>
                        <Item
                          icon={<Plus className="h-4 w-4" />}
                          onSelect={() =>
                            go({ kind: 'nav', title: 'New Client', href: '/clients?new=1' })
                          }
                        >
                          New Client
                        </Item>
                      </>
                    ) : null}
                    <Item
                      icon={<Plus className="h-4 w-4" />}
                      onSelect={() =>
                        go({ kind: 'nav', title: 'New Document', href: '/documents?new=1' })
                      }
                    >
                      New Document
                    </Item>
                  </Command.Group>
                </>
              ) : null}

              {showSearch ? (
                <Command.Group heading="Search">
                  <Item
                    icon={<Search className="h-4 w-4" />}
                    onSelect={() => {
                      setOpen(false);
                      setQuery('');
                      router.push(`/search?q=${encodeURIComponent(debouncedQuery.trim())}`);
                    }}
                  >
                    {withModifiers ? 'Search everything for' : 'See all results for'} &ldquo;
                    {debouncedQuery.trim()}&rdquo;
                  </Item>
                </Command.Group>
              ) : null}

              {showSearch && !withModifiers && search.data && search.data.results.length > 0 ? (
                <Command.Group heading="Search results">
                  {search.data.results.map((r) => (
                    <SearchResultItem
                      key={`${r.kind}-${r.id}`}
                      result={r}
                      onSelect={() =>
                        go({
                          kind: r.kind,
                          title: r.title,
                          context: r.context,
                          href: r.href,
                        })
                      }
                    />
                  ))}
                </Command.Group>
              ) : null}
            </Command.List>
          </Command>
        </div>
      ) : null}
    </>
  );
}

interface RecentItem {
  kind: SearchResult['kind'] | 'nav';
  title: string;
  context?: string | null;
  href: string;
}

const RECENT_KEY = 'botss:command-palette:recent';
function loadRecent(): RecentItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as RecentItem[]) : [];
  } catch {
    return [];
  }
}
function pushRecent(item: RecentItem): void {
  if (typeof window === 'undefined') return;
  const curr = loadRecent().filter((r) => r.href !== item.href);
  const next = [item, ...curr].slice(0, 5);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable; silently drop */
  }
}

function iconFor(kind: RecentItem['kind']): React.ReactNode {
  switch (kind) {
    case 'task':
      return <FolderKanban className="h-4 w-4" />;
    case 'project':
      return <FolderKanban className="h-4 w-4" />;
    case 'lead':
      return <Users className="h-4 w-4" />;
    case 'client':
      return <Briefcase className="h-4 w-4" />;
    case 'document':
      return <FileText className="h-4 w-4" />;
    case 'chat_message':
      return <MessageSquare className="h-4 w-4" />;
    case 'chat_room':
      return <Hash className="h-4 w-4" />;
    case 'file':
    case 'workspace_file':
      return <Paperclip className="h-4 w-4" />;
    case 'mail':
      return <Mail className="h-4 w-4" />;
    case 'person':
      return <Users className="h-4 w-4" />;
    default:
      return <Search className="h-4 w-4" />;
  }
}

function Item({
  icon,
  onSelect,
  children,
  shortcut,
}: {
  icon?: React.ReactNode;
  onSelect: () => void;
  children: React.ReactNode;
  shortcut?: string;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="aria-selected:bg-brand-50 aria-selected:text-brand-700 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm"
    >
      {icon ? <span className="text-ink-muted">{icon}</span> : null}
      <span className="flex-1">{children}</span>
      {shortcut ? (
        <kbd className="border-line bg-bg-subtle text-ink-muted ml-2 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase">
          {shortcut}
        </kbd>
      ) : null}
    </Command.Item>
  );
}

function SearchResultItem({ result, onSelect }: { result: SearchResult; onSelect: () => void }) {
  const icon = useMemo(() => iconFor(result.kind), [result.kind]);
  return (
    <Item icon={icon} onSelect={onSelect}>
      <span>{result.title}</span>
      <span className="text-ink-disabled ml-2 text-xs uppercase tracking-wide">
        {result.kind.replace('_', ' ')}
      </span>
      {result.context ? (
        <span className="text-ink-disabled ml-auto truncate text-xs">{result.context}</span>
      ) : null}
    </Item>
  );
}
