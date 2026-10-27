'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import type { SystemRole } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';

/**
 * Client-side defense-in-depth guard: redirect away if the signed-in user's
 * systemRole isn't in `allowed`. The server still enforces access (this is a
 * UX gate so unauthorized users don't sit on a page that only 403s), mirroring
 * the redirect pattern in the admin layout.
 *
 * Call it at the top of a page component; render `fallback`-style loading
 * while `checking` or until the redirect completes (`allowed === false`).
 */
export function useRequireSystemRole(
  allowed: readonly SystemRole[],
  redirectTo = '/home',
): { checking: boolean; allowed: boolean } {
  const router = useRouter();
  const session = useSessionContext();
  const role = session.data?.user?.systemRole;
  const checking = session.isPending;
  const isAllowed = !!role && allowed.includes(role);

  useEffect(() => {
    if (checking) return;
    if (!isAllowed) router.replace(redirectTo);
  }, [checking, isAllowed, redirectTo, router]);

  return { checking, allowed: isAllowed };
}
