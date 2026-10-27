'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Calls `onChange` whenever the page's search string changes - including
 * Next.js client navigations, which fire no popstate. Renders nothing; the
 * page mounts it inside <Suspense> because useSearchParams needs a boundary
 * for static rendering.
 */
export function DashboardUrlWatcher({ onChange }: { onChange: () => void }) {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  useEffect(() => {
    onChange();
  }, [search, onChange]);
  return null;
}
