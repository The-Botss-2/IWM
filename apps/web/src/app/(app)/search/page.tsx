'use client';

import {
  Briefcase,
  FileText,
  FolderKanban,
  Hash,
  Mail,
  MessageSquare,
  Paperclip,
  Search as SearchIcon,
  User,
  Users,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { SEARCH_COUNT_CAP, type SearchResult, type SearchResultKind } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Loader, PageLoader } from '@/components/ui/loader';
import { useCreateChatRoom } from '@/hooks/use-chat';
import {
  canSearch,
  useResolvedSearch,
  useSearchCounts,
  useSearchResults,
  useTopResults,
  type SearchSort,
} from '@/hooks/use-search';
import { formatSearchQuery, hasSearchFilters, highlightSegments, parseSearchQuery } from '@/lib/search-query';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

type Tab = SearchResultKind | 'all';

const KIND_TABS: { kind: SearchResultKind; label: string }[] = [
  { kind: 'chat_message', label: 'Messages' },
  { kind: 'file', label: 'Chat files' },
  { kind: 'workspace_file', label: 'Files' },
  { kind: 'chat_room', label: 'Channels' },
  { kind: 'person', label: 'People' },
  { kind: 'mail', label: 'Mail' },
  { kind: 'task', label: 'Tasks' },
  { kind: 'document', label: 'Docs' },
  { kind: 'project', label: 'Projects' },
  { kind: 'lead', label: 'Leads' },
  { kind: 'client', label: 'Clients' },
];

const TABS: { kind: Tab; label: string }[] = [{ kind: 'all', label: 'All' }, ...KIND_TABS];

const KIND_LABEL = Object.fromEntries(KIND_TABS.map((t) => [t.kind, t.label])) as Record<SearchResultKind, string>;

/** Tabs where from / in / date filters apply. */
const FILTERABLE = new Set<Tab>(['all', 'chat_message', 'file', 'workspace_file', 'mail', 'task', 'document']);

/** Tabs that offer the `has:file` chip. */
const HAS_FILE_TABS = new Set<Tab>(['all', 'chat_message', 'mail']);

function toIsoDay(date: Date | null): string | null {
  if (!date) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function SearchPage() {
  return (
    <Suspense fallback={<PageLoader label="Loading search" />}>
      <SearchPageInner />
    </Suspense>
  );
}

function SearchPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSessionContext();
  const userId = session.data?.user.id ?? '';
  const createRoom = useCreateChatRoom();

  const urlQuery = params.get('q') ?? '';
  const urlTab = (params.get('tab') as Tab | null) ?? 'all';
  const tab: Tab = TABS.some((t) => t.kind === urlTab) ? urlTab : 'all';
  const sort: SearchSort = params.get('sort') === 'recent' ? 'recent' : 'relevance';
  const [box, setBox] = useState(urlQuery);
  useEffect(() => setBox(urlQuery), [urlQuery]);

  const parsed = useMemo(() => parseSearchQuery(urlQuery), [urlQuery]);
  const { filters, unresolved, fromUser, inRoom, roomOptions, peopleOptions } = useResolvedSearch(
    parsed,
    userId,
    sort,
  );

  const counts = useSearchCounts(filters, !unresolved);
  const results = useSearchResults(tab === 'all' ? 'chat_message' : tab, filters, tab !== 'all' && !unresolved);
  const top = useTopResults(filters, tab === 'all' && !unresolved);

  function navigate(nextQuery: string, nextTab: Tab = tab, nextSort: SearchSort = sort) {
    const usp = new URLSearchParams();
    if (nextQuery.trim()) usp.set('q', nextQuery.trim());
    usp.set('tab', nextTab);
    if (nextSort === 'recent') usp.set('sort', 'recent');
    router.replace(`/search?${usp.toString()}`);
  }

  function setFilter(patch: Partial<typeof parsed>) {
    navigate(formatSearchQuery({ ...parsed, ...patch }));
  }

  async function openResult(r: SearchResult) {
    if (r.kind === 'person') {
      // Failure is toasted by useCreateChatRoom's onError; just don't navigate.
      const room = await createRoom.mutateAsync({ type: 'DM', participantUserIds: [r.id] }).catch(() => null);
      if (room) router.push(`/chat/${room.id}`);
      return;
    }
    if (r.href.startsWith('http')) {
      window.open(r.href, '_blank', 'noopener,noreferrer');
      return;
    }
    router.push(r.href);
  }

  const active = tab === 'all' ? top : results;
  const items = (tab === 'all' ? top.data : results.data?.pages.flatMap((p) => p.results)) ?? [];
  const showFilters = FILTERABLE.has(tab);
  // Nothing to search yet: under two characters and no filter. A typed filter
  // whose name matched nothing falls through to the "Filter not found" state.
  const tooShort = !canSearch(filters) && !unresolved;
  // Kinds with hits, for the "See all in ..." links under the All tab.
  const kindsWithHits = KIND_TABS.filter(
    (t) => (counts.data?.[t.kind] ?? 0) > 0 || items.some((r) => r.kind === t.kind),
  );

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          navigate(box);
        }}
        className="relative"
        role="search"
      >
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled" aria-hidden />
        <Input
          autoFocus
          value={box}
          onChange={(e) => setBox(e.target.value)}
          placeholder='Search messages, files, people and more. Try: invoice from:@sara in:#finance has:file'
          className="h-11 pl-9"
          aria-label="Search"
        />
      </form>

      {showFilters ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-full sm:w-56">
            <Combobox
              options={peopleOptions}
              value={fromUser?.value ?? null}
              onChange={(id) => {
                const person = peopleOptions.find((p) => p.value === id);
                setFilter({ from: person ? person.label : null });
              }}
              placeholder="From anyone"
              clearable
            />
          </div>
          {tab !== 'mail' && tab !== 'task' && tab !== 'document' && tab !== 'workspace_file' ? (
            <div className="w-full sm:w-56">
              <Combobox
                options={roomOptions}
                value={inRoom?.value ?? null}
                onChange={(id) => {
                  const room = roomOptions.find((r) => r.value === id);
                  setFilter({ in: room ? room.label.replace(/^#/, '') : null, inDm: null });
                }}
                placeholder="In any chat"
                clearable
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <DatePicker
              size="sm"
              placeholder="After"
              value={parsed.after ? new Date(`${parsed.after}T00:00:00`) : null}
              onChange={(d) => setFilter({ after: toIsoDay(d) })}
            />
            <DatePicker
              size="sm"
              placeholder="Before"
              value={parsed.before ? new Date(`${parsed.before}T00:00:00`) : null}
              onChange={(d) => setFilter({ before: toIsoDay(d) })}
            />
          </div>
          {HAS_FILE_TABS.has(tab) ? (
            <button
              type="button"
              onClick={() => setFilter({ has: parsed.has === 'file' ? null : 'file' })}
              aria-pressed={parsed.has === 'file'}
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
                parsed.has === 'file'
                  ? 'border-ink bg-ink text-bg-surface'
                  : 'border-line text-ink-muted hover:bg-bg-subtle',
              )}
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden /> Has file
            </button>
          ) : null}
          {hasSearchFilters(parsed) ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setFilter({ from: null, in: null, inDm: null, has: null, after: null, before: null })
              }
            >
              <X className="h-4 w-4" /> Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      <nav className="-mx-1 flex gap-1 overflow-x-auto pb-1" aria-label="Result types">
        {TABS.map((t) => {
          const count = t.kind === 'all' ? undefined : counts.data?.[t.kind];
          const active = t.kind === tab;
          return (
            <button
              key={t.kind}
              type="button"
              onClick={() => navigate(urlQuery, t.kind)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
                active ? 'bg-ink text-bg-surface' : 'text-ink-muted hover:bg-bg-subtle',
              )}
            >
              {t.label}
              {count !== undefined ? (
                <span className={cn('text-xs tabular-nums', active ? 'opacity-80' : 'text-ink-disabled')}>
                  {count > SEARCH_COUNT_CAP ? `${SEARCH_COUNT_CAP}+` : count}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {!tooShort && !unresolved ? (
        <div className="flex items-center justify-end gap-1 text-xs" role="group" aria-label="Sort results">
          {(
            [
              ['relevance', 'Most relevant'],
              ['recent', 'Newest'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => navigate(urlQuery, tab, value)}
              aria-pressed={sort === value}
              className={cn(
                'rounded-md px-2 py-1 transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
                sort === value ? 'bg-bg-subtle font-medium text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      {tooShort ? (
        <EmptyState
          title="Search everything in this workspace"
          body='Type at least two characters, or use a filter on its own. Narrow it down with from:@name, in:#channel, in:@name, has:file, has:link, after:2026-09-01 and before:2026-09-30. Put "quotes" around a phrase, and -word leaves a word out.'
        />
      ) : unresolved ? (
        <EmptyState title="Filter not found" body={unresolved} />
      ) : active.isLoading ? (
        <PageLoader label="Searching" className="min-h-[12rem]" />
      ) : active.isError ? (
        <EmptyState
          title="Couldn't search"
          body="Something went wrong on our side."
          action={
            <Button size="sm" onClick={() => void active.refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No results"
          body={
            tab === 'all'
              ? 'Nothing matches. Try fewer words or another filter.'
              : `Nothing in ${KIND_LABEL[tab]} matches.`
          }
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-bg-surface">
          {items.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <button
                type="button"
                onClick={() => void openResult(r)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-bg-subtle focus-visible:bg-bg-subtle focus-visible:outline-none"
              >
                <span className="mt-0.5 text-ink-disabled">{iconFor(r.kind)}</span>
                <span className="min-w-0 flex-1">
                  {tab === 'all' ? (
                    <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-ink-disabled">
                      {KIND_LABEL[r.kind]}
                    </span>
                  ) : null}
                  <span className="block truncate text-sm font-medium text-ink">
                    <Highlight text={r.title} term={parsed.text} />
                  </span>
                  {r.snippet && r.snippet !== r.title ? (
                    <span className="mt-0.5 line-clamp-2 block text-sm text-ink-muted">
                      <Highlight text={r.snippet} term={parsed.text} />
                    </span>
                  ) : null}
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-ink-disabled">
                    {r.context ? <span>{r.context}</span> : null}
                    {r.actorName ? <span>{r.actorName}</span> : null}
                    {r.at ? <span>{relativeTime(r.at)}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {tab !== 'all' && results.hasNextPage ? (
            <li className="flex justify-center p-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void results.fetchNextPage()}
                disabled={results.isFetchingNextPage}
              >
                {results.isFetchingNextPage ? <Loader size="xs" label="Loading more" /> : null}
                Load more
              </Button>
            </li>
          ) : null}
        </ul>
      )}

      {tab === 'all' && !tooShort && !unresolved && kindsWithHits.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {kindsWithHits.map((t) => {
            const count = counts.data?.[t.kind];
            return (
              <Button key={t.kind} variant="secondary" size="sm" onClick={() => navigate(urlQuery, t.kind)}>
                See all in {t.label}
                {count !== undefined ? (
                  <span className="tabular-nums text-ink-disabled">
                    {count > SEARCH_COUNT_CAP ? `${SEARCH_COUNT_CAP}+` : count}
                  </span>
                ) : null}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  return (
    <>
      {highlightSegments(text, term).map((seg, i) =>
        seg.match ? (
          <mark key={i} className="rounded-sm bg-brand-50 px-0.5 text-ink">
            {seg.value}
          </mark>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line bg-bg-surface px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-md text-sm text-ink-muted">{body}</p>
      {action}
    </div>
  );
}

function iconFor(kind: SearchResultKind) {
  const cls = 'h-4 w-4';
  switch (kind) {
    case 'chat_message':
      return <MessageSquare className={cls} />;
    case 'chat_room':
      return <Hash className={cls} />;
    case 'file':
    case 'workspace_file':
      return <Paperclip className={cls} />;
    case 'person':
      return <User className={cls} />;
    case 'mail':
      return <Mail className={cls} />;
    case 'task':
    case 'project':
      return <FolderKanban className={cls} />;
    case 'document':
      return <FileText className={cls} />;
    case 'lead':
      return <Users className={cls} />;
    case 'client':
      return <Briefcase className={cls} />;
    default:
      return <SearchIcon className={cls} />;
  }
}
