import Link from 'next/link';
import type { ReactNode } from 'react';

import { Logo } from '@/components/branding/logo';

/**
 * Minimal layout for the public reader route. Deliberately does NOT mount the
 * app shell (sidebar, topbar, session gate) - these pages are reachable by
 * anonymous viewers and must not require authentication or leak workspace UI.
 */
export default function PublicReaderLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg-subtle">
      <header className="border-b border-line bg-bg-surface">
        <div className="mx-auto flex max-w-3xl items-center justify-center px-4 py-4 sm:px-6">
          <Link
            href="/"
            aria-label="The Botss home"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          >
            <Logo variant="full" size="sm" />
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}
