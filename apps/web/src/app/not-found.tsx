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
      <p className="text-5xl font-bold text-brand-purple">404</p>
      <h1 className="mt-3 text-lg font-semibold text-ink">Page not found</h1>
      <p className="mt-1 max-w-md text-sm text-ink-muted">
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
