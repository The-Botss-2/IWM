'use client';

import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * Thin progress strip pinned to the top of the viewport. Shows whenever any
 * TanStack Query request or mutation is in flight, so the user sees a
 * heartbeat during slow API calls (the API can take a few seconds on a
 * cold container, otherwise the screen looks frozen). Auto-hides shortly
 * after all queries settle so it doesn't strobe on every tiny refetch.
 *
 * Renders inside `Providers` so it has access to the shared QueryClient
 * via the React Query context. Pure UX hint - no business logic.
 */
export function GlobalProgress() {
  const fetching = useIsFetching();
  const mutating = useIsMutating();
  const active = fetching + mutating;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (active > 0) {
      setVisible(true);
      return;
    }
    // Brief grace period before hiding so a sub-100ms refetch still flashes
    // the bar - without this the bar can disappear before users perceive it.
    const t = window.setTimeout(() => setVisible(false), 250);
    return () => window.clearTimeout(t);
  }, [active]);

  if (!visible) return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading"
      aria-busy={active > 0}
      className="pointer-events-none fixed left-0 right-0 top-0 z-[60] h-0.5 overflow-hidden bg-transparent"
    >
      <div className="h-full w-1/3 animate-progress-slide bg-brand-gradient" />
    </div>
  );
}
