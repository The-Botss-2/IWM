'use client';

import { useQuery } from '@tanstack/react-query';
import type { SalesAccess } from '@botss/shared-types';

import { getApi } from '@/lib/api';

const salesAccessKey = ['sales-access'] as const;

/** Nothing is visible until the server says otherwise - failing closed keeps a
 *  network error from flashing the Leads/Clients tabs at someone who has none. */
const NO_ACCESS: SalesAccess = { fullAccess: false, leads: false, clients: false };

/**
 * Whether to offer the Leads / Clients surfaces to the signed-in user.
 *
 * Access has two sources and only the server can see both: a sales systemRole
 * or workspace OWNER/ADMIN role unlocks everything, and otherwise having a
 * lead or client assigned to you unlocks that section on its own. That's why
 * this is a fetch rather than a role check on the session object.
 *
 * `isLoading` matters for route guards - redirecting before the answer arrives
 * would bounce a legitimately-assigned user off their own page.
 */
export function useSalesAccess(): SalesAccess & { isLoading: boolean } {
  const query = useQuery({
    queryKey: salesAccessKey,
    queryFn: () => getApi().salesAccess.get(),
    // Assignment changes are rare and arrive via notification anyway; a minute
    // of staleness costs nothing and keeps this off the hot path of every nav.
    staleTime: 60_000,
    retry: false,
  });
  return { ...(query.data ?? NO_ACCESS), isLoading: query.isPending };
}
