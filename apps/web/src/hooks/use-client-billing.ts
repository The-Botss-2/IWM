'use client';

import { useQuery } from '@tanstack/react-query';

import { getApi } from '@/lib/api';

/**
 * Under `['finance', 'summary']` so every money write (contract, payment)
 * that refreshes the finance summary refreshes this one too.
 */
const clientBillingKey = (clientId: string) =>
  ['finance', 'summary', 'client', clientId] as const;

/** Per-currency billing totals for one client. Finance roles only. */
export function useClientBilling(clientId: string, enabled = true) {
  return useQuery({
    queryKey: clientBillingKey(clientId),
    queryFn: () => getApi().clients.billingSummary(clientId),
    enabled: enabled && !!clientId,
    staleTime: 30_000,
    retry: 1,
  });
}

/**
 * The organisation's base currency (what every rate and base amount is
 * against), or null while it loads or after it failed. Never guessed: money
 * forms wait, or offer Retry, rather than assume one.
 *
 * Read through the current month's finance summary under its own stable key,
 * so every finance screen and dialog that needs it shares one read whatever
 * tab or page the person landed on. The base currency practically never
 * changes, hence the long stale time.
 */
export function useFinanceBaseCurrency(enabled = true): {
  baseCurrency: string | null;
  isError: boolean;
  retry: () => void;
} {
  const query = useQuery({
    queryKey: ['finance', 'base-currency'],
    queryFn: async () => {
      const to = new Date();
      const from = new Date(to.getFullYear(), to.getMonth(), 1);
      const summary = await getApi().finance.summary({ from, to });
      return summary.baseCurrency;
    },
    enabled,
    staleTime: 10 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    meta: { silentError: true },
  });
  return {
    baseCurrency: query.data ?? null,
    isError: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}
