'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { useSalesAccess } from '@/hooks/use-sales-access';

/**
 * Client-side defense-in-depth guard for the Leads / Clients pages: redirect
 * away when the user has neither full sales access nor anything assigned to
 * them in that section. The API enforces the same rule; this exists so an
 * unauthorized user isn't parked on a page that can only 403.
 *
 * Unlike a plain role check this has to wait for the server - assignment is
 * data, not a claim on the session - so callers must render a loading state
 * while `checking` is true rather than treating it as denied.
 */
export function useRequireSalesAccess(
  section: 'leads' | 'clients',
  redirectTo = '/home',
): { checking: boolean; allowed: boolean } {
  const router = useRouter();
  const sales = useSalesAccess();
  const checking = sales.isLoading;
  const allowed = sales[section];

  useEffect(() => {
    if (checking) return;
    if (!allowed) router.replace(redirectTo);
  }, [checking, allowed, redirectTo, router]);

  return { checking, allowed };
}
