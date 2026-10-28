'use client';

import { Button } from './button';
import { cn } from '@/lib/utils';

/**
 * Shown in place of a loading/empty state when a TanStack query fails, so a
 * failed request never silently renders as "no data". Pass `onRetry` to
 * surface a retry button (usually `() => void query.refetch()`).
 */
export function QueryError({
  message = "Couldn't load this.",
  onRetry,
  className,
  compact = false,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'border-line bg-bg-surface rounded-md border',
        compact ? 'p-2 text-xs' : 'p-4',
        className,
      )}
    >
      <p className="text-ink-muted text-sm">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-2">
          Try again
        </Button>
      ) : null}
    </div>
  );
}
