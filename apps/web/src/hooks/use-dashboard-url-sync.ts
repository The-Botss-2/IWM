'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { selectDashboardFilterValues, useDashboardFilters } from '@/hooks/use-dashboard-filters';
import {
  hasDashboardUrlParams,
  parseDashboardUrl,
  serializeDashboardUrl,
  type DashboardFilterValues,
} from '@/lib/dashboard-filters';

/** What made the URL change: first mount, a Next client navigation, or Back/Forward. */
type SyncMode = 'initial' | 'nav' | 'pop';

/** Typing in the search box rewrites the URL at most this often. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Write `values` into the URL; returns the resulting `location.search`.
 * Shallow: Next.js syncs history.replaceState with useSearchParams without a
 * navigation or an RSC round trip, and replacing keeps the Back button free
 * of one entry per filter click.
 */
function writeUrl(values: DashboardFilterValues): string {
  const { pathname, search, hash } = window.location;
  const qs = serializeDashboardUrl(values, new URLSearchParams(search)).toString();
  const nextSearch = qs ? `?${qs}` : '';
  if (nextSearch !== search) {
    window.history.replaceState(null, '', `${pathname}${nextSearch}${hash}`);
  }
  return nextSearch;
}

/**
 * Keeps the dashboard filters and the page URL in step, so a filtered view
 * survives a reload and can be shared as a link.
 *
 * - On mount, and on a Next client navigation (`onUrlChange`, called by the
 *   page's useSearchParams watcher), the URL wins when it carries any
 *   dashboard param; a bare /dashboard instead keeps the in-memory filters
 *   (from earlier this session) and writes them into the URL.
 * - On Back/Forward (popstate) the URL always wins, a bare one included, so
 *   history restores exactly the view it recorded.
 * - Every filter change replaces the URL: immediately, or debounced while the
 *   search text changes. Clear all resets the store, which clears the params.
 * - URLs this hook wrote itself are ignored after mount, so a debounced write
 *   can't roll back text typed after it.
 *
 * `ready` turns true only after the store holds the URL's filters. Render the
 * filter-dependent widgets only then: their queries subscribe in the passive
 * effect phase of the first commit, before a hydration re-render would land,
 * so mounting them earlier fires (and, with keepPreviousData, shows) the
 * unfiltered view first.
 */
export function useDashboardUrlSync(): { ready: boolean; onUrlChange: () => void } {
  const [ready, setReady] = useState(false);
  const lastWritten = useRef<string | null>(null);
  // popstate fires before React unmounts the page, so Back/Forward away from
  // the dashboard still reaches these handlers with the next page's URL. Only
  // ever read or write the dashboard's own URL.
  const dashboardPath = useRef<string | null>(null);

  const syncFromUrl = useCallback((mode: SyncMode) => {
    if (mode !== 'initial' && window.location.pathname !== dashboardPath.current) return;
    const { search } = window.location;
    if (mode !== 'initial' && search === lastWritten.current) return;
    const store = useDashboardFilters.getState();
    const sp = new URLSearchParams(search);
    // Back/Forward restores exactly what that history entry held, even "no
    // filters". A mount or client navigation to a bare /dashboard link keeps
    // the session's filters (and writes them back), so the sidebar link
    // behaves the same whether you are on the dashboard already or not.
    if (mode === 'pop' || hasDashboardUrlParams(sp)) store.replaceAll(parseDashboardUrl(sp));
    // Also normalises a hand-edited URL (drops values that didn't parse).
    lastWritten.current = writeUrl(selectDashboardFilterValues(useDashboardFilters.getState()));
  }, []);

  useLayoutEffect(() => {
    dashboardPath.current = window.location.pathname;
    syncFromUrl('initial');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = useDashboardFilters.subscribe((state, prev) => {
      clearTimeout(timer);
      const values = selectDashboardFilterValues(state);
      const write = () => {
        if (window.location.pathname !== dashboardPath.current) return;
        lastWritten.current = writeUrl(values);
      };
      if (state.search !== prev.search) timer = setTimeout(write, SEARCH_DEBOUNCE_MS);
      else write();
    });
    const onPopState = () => syncFromUrl('pop');
    window.addEventListener('popstate', onPopState);
    setReady(true);
    return () => {
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('popstate', onPopState);
    };
  }, [syncFromUrl]);

  const onUrlChange = useCallback(() => syncFromUrl('nav'), [syncFromUrl]);
  return { ready, onUrlChange };
}
