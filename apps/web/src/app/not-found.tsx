import Link from 'next/link';

import { Button } from '@/components/ui/button';

/**
 * Branded 404. Replaces Next's default not-found page for any unmatched
 * route (and any `notFound()` call). Server component - no interactivity
 * beyond the link.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <p className="text-brand-purple text-5xl font-bold">404</p>
      <h1 className="text-ink mt-3 text-lg font-semibold">Page not found</h1>
      <p className="text-ink-muted mt-1 max-w-md text-sm">
        The page you are looking for does not exist or may have been moved.
      </p>
      <div className="mt-6">
        <Button asChild>
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
