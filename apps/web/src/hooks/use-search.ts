'use client';

import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SearchParams } from '@botss/api-client';
import type { SearchResultKind } from '@botss/shared-types';

import { useChatRooms } from '@/hooks/use-chat';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import { getApi } from '@/lib/api';
import { roomTitle } from '@/lib/chat-room-label';
import type { ParsedSearch } from '@/lib/search-query';

export type SearchSort = 'relevance' | 'recent';

export interface SearchFilters {
  q: string;
  fromUserId?: string | null;
  roomId?: string | null;
  has?: 'file' | 'link' | null;
  after?: string | null;
  before?: string | null;
  sort?: SearchSort;
}

function toParams(filters: SearchFilters): Omit<SearchParams, 'kind'> {
  return {
    q: filters.q,
    ...(filters.fromUserId ? { fromUserId: filters.fromUserId } : {}),
    ...(filters.roomId ? { roomId: filters.roomId } : {}),
    ...(filters.has ? { has: filters.has } : {}),
    ...(filters.sort ? { sort: filters.sort } : {}),
    // Date filters are whole days in the user's calendar.
    ...(filters.after ? { after: new Date(`${filters.after}T00:00:00`).toISOString() } : {}),
    ...(filters.before ? { before: new Date(`${filters.before}T23:59:59.999`).toISOString() } : {}),
  };
}

/**
 * Whether these filters are enough to search: two characters of text, or any
 * filter on its own (`has:file`, `from:@sara`, ...). Mirrors the API's rule.
 */
export function canSearch(filters: SearchFilters): boolean {
  return (
    filters.q.trim().length >= 2 ||
    Boolean(filters.fromUserId || filters.roomId || filters.has || filters.after || filters.before)
  );
}

const PAGE_SIZE = 25;

/** Every kind, for the search page's "All" tab. */
const ALL_KINDS: SearchResultKind[] = [
  'chat_message',
  'file',
  'workspace_file',
  'chat_room',
  'person',
  'mail',
  'task',
  'document',
  'project',
  'lead',
  'client',
];

/** One tab of the search page, paged. */
export function useSearchResults(kind: SearchResultKind, filters: SearchFilters, enabled: boolean) {
  const params = toParams(filters);
  return useInfiniteQuery({
    queryKey: ['search', 'page', kind, params],
    queryFn: ({ pageParam }) =>
      getApi().search.query({
        ...params,
        kind,
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: enabled && canSearch(filters),
    staleTime: 30_000,
  });
}

/**
 * The "All" tab: the best hits of every kind, merged and ranked by the server
 * (palette mode). Grouping by kind is left to the page.
 */
export function useTopResults(filters: SearchFilters, enabled: boolean) {
  const params = toParams(filters);
  return useQuery({
    queryKey: ['search', 'top', params],
    queryFn: () => getApi().search.query({ ...params, kinds: ALL_KINDS, limit: 50 }),
    enabled: enabled && canSearch(filters),
    staleTime: 30_000,
    select: (data) => data.results,
  });
}

/** Capped per-kind counts for the tab labels. */
export function useSearchCounts(filters: SearchFilters, enabled: boolean) {
  const params = toParams(filters);
  return useQuery({
    queryKey: ['search', 'counts', params],
    queryFn: () => getApi().search.query({ ...params, kind: 'chat_message', limit: 1, counts: true }),
    enabled: enabled && canSearch(filters),
    staleTime: 30_000,
    select: (data) => data.counts ?? {},
  });
}

/**
 * Server-side search inside one chat room (the conversation's search bar):
 * newest first, so it finds messages that are not loaded yet. Returns the
 * matching messages (id + time) oldest-to-newest, the order the window steps
 * through.
 */
export function useRoomMessageSearch(roomId: string, q: string, enabled: boolean) {
  const text = q.trim();
  return useQuery({
    queryKey: ['search', 'room', roomId, text],
    queryFn: () =>
      getApi().search.query({ q: text, kind: 'chat_message', roomId, sort: 'recent', limit: 50 }),
    enabled: enabled && text.length >= 2,
    staleTime: 30_000,
    select: (data) => data.results.map((r) => ({ id: r.id, at: r.at ?? null })).reverse(),
    meta: { errorTitle: "Couldn't search this conversation" },
  });
}

export interface SearchOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Resolves the names typed in the box (`from:@sara`, `in:#design`,
 * `in:@sara`) to ids against the workspace members and the caller's chat
 * rooms, and builds the filters the search hooks take. `unresolved` explains
 * a name that matched nothing, once the lists have loaded.
 */
export function useResolvedSearch(parsed: ParsedSearch, userId: string, sort: SearchSort) {
  const rooms = useChatRooms();
  const members = useWorkspaceMembers();

  // Only rooms the user has joined: the chat list also shows open channels
  // they can read without joining, but search only covers rooms they are a
  // participant of, so offering those would quietly return nothing.
  const joinedRooms = useMemo(
    () => (rooms.data?.items ?? []).filter((r) => r.participants.some((p) => p.userId === userId)),
    [rooms.data, userId],
  );
  const roomOptions = useMemo<SearchOption[]>(
    () =>
      joinedRooms.map((r) => ({
        value: r.id,
        label: roomTitle(r, userId).replace(/^# /, '#'),
      })),
    [joinedRooms, userId],
  );
  const peopleOptions = useMemo<SearchOption[]>(
    () =>
      (members.data ?? []).map((m) => ({
        value: m.user.id,
        label: m.user.name?.trim() || m.user.email,
        description: m.user.email,
      })),
    [members.data],
  );

  const fromUser = useMemo(() => {
    if (!parsed.from) return null;
    const needle = parsed.from.toLowerCase();
    return (
      peopleOptions.find((p) => p.label.toLowerCase() === needle || p.description?.toLowerCase() === needle) ??
      peopleOptions.find((p) => p.label.toLowerCase().includes(needle)) ??
      null
    );
  }, [parsed.from, peopleOptions]);

  const inRoom = useMemo(() => {
    if (parsed.inDm) {
      // The direct message whose other participant matches the name or email.
      const needle = parsed.inDm.toLowerCase();
      const dms = joinedRooms.filter((r) => r.type === 'DM');
      const peerOf = (r: (typeof dms)[number]) => r.participants.find((p) => p.userId !== userId)?.user;
      const match =
        dms.find((r) => {
          const peer = peerOf(r);
          return peer?.name?.toLowerCase() === needle || peer?.email.toLowerCase() === needle;
        }) ?? dms.find((r) => peerOf(r)?.name?.toLowerCase().includes(needle));
      return match ? (roomOptions.find((o) => o.value === match.id) ?? null) : null;
    }
    if (!parsed.in) return null;
    const needle = parsed.in.toLowerCase();
    return (
      roomOptions.find((r) => r.label.replace(/^#/, '').toLowerCase() === needle) ??
      roomOptions.find((r) => r.label.toLowerCase().includes(needle)) ??
      null
    );
  }, [parsed.in, parsed.inDm, roomOptions, joinedRooms, userId]);

  // `in:#general` naming a channel the user can see but hasn't joined.
  const unjoinedRoom = useMemo(() => {
    if (!parsed.in || inRoom) return null;
    const needle = parsed.in.toLowerCase();
    const joined = new Set(joinedRooms.map((r) => r.id));
    return (
      (rooms.data?.items ?? []).find(
        (r) => !joined.has(r.id) && roomTitle(r, userId).replace(/^#\s*/, '').toLowerCase() === needle,
      ) ?? null
    );
  }, [parsed.in, inRoom, joinedRooms, rooms.data, userId]);

  const filters: SearchFilters = {
    q: parsed.text,
    fromUserId: fromUser?.value ?? null,
    roomId: inRoom?.value ?? null,
    has: parsed.has,
    after: parsed.after,
    before: parsed.before,
    sort,
  };
  const unresolved =
    (parsed.from && !fromUser && members.data ? `No one named "${parsed.from}" in this workspace.` : null) ??
    (parsed.in && !inRoom && unjoinedRoom ? `Join #${parsed.in} to search it.` : null) ??
    (parsed.in && !inRoom && rooms.data ? `No chat named "${parsed.in}".` : null) ??
    (parsed.inDm && !inRoom && rooms.data ? `No direct message with "${parsed.inDm}".` : null);

  return { filters, unresolved, fromUser, inRoom, roomOptions, peopleOptions };
}
