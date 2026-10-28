'use client';

import { Button } from '@/components/ui/button';
import type { useFinanceBaseCurrency } from '@/hooks/use-client-billing';

/**
 * Shown in a money dialog while the organisation's base currency is not
 * known: "waiting" while it loads, or the failure with a Retry. Renders
 * nothing once it is known.
 */
export function BaseCurrencyNotice({ base }: { base: ReturnType<typeof useFinanceBaseCurrency> }) {
  if (base.baseCurrency) return null;
  if (base.isError) {
    return (
      <div className="text-state-error flex items-center gap-2 text-xs" role="alert">
        <span>Couldn&apos;t load the organisation&apos;s base currency. Saving is paused.</span>
        <Button type="button" size="sm" variant="secondary" onClick={base.retry}>
          Retry
        </Button>
      </div>
    );
  }
  return (
    <p className="text-ink-muted text-xs" role="status">
      Waiting for the organisation&apos;s base currency. Saving is paused until it loads.
    </p>
  );
}
