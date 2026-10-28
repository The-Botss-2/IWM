'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { reportClientError } from '@/lib/report-client-error';

/**
 * Segment-level error boundary for the client portal. Same shape as the
 * internal app's, but it sends people back to their portal: the internal
 * dashboard is not somewhere a client account can go.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, { boundary: 'portal', digest: error.digest });
  }, [error]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
      <div className="bg-bg-subtle text-state-error flex h-12 w-12 items-center justify-center rounded-full">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </div>
      <h1 className="text-ink mt-4 text-lg font-semibold">Something went wrong</h1>
      <p className="text-ink-muted mt-1 max-w-md text-sm">
        This page hit an unexpected error. You can try again, or go back to your portal.
      </p>
      {error.digest ? (
        <p className="text-ink-disabled mt-2 text-xs">Reference: {error.digest}</p>
      ) : null}
      <div className="mt-6 flex items-center gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="secondary" asChild>
          <Link href="/portal">Back to your portal</Link>
        </Button>
      </div>
    </div>
  );
}
