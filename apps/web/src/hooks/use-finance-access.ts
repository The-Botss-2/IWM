'use client';

import { usePermissions } from '@/hooks/use-permissions';

/**
 * May the signed-in user see money (contracts, invoices, payments)? The same
 * rule the API applies (company `finance.view` / `finance.manage`). A UX hint
 * only: the server refuses finance reads for everyone else regardless.
 */
export function useFinanceAccess(): { checking: boolean; allowed: boolean } {
  const perms = usePermissions();
  return { checking: perms.checking, allowed: perms.isFinance };
}
