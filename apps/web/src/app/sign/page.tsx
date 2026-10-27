import Link from 'next/link';

import { Logo } from '@/components/branding/logo';

/**
 * `/sign` without a link token. A code on its own no longer opens anything:
 * the signer needs the full link from the email, and the page behind it asks
 * for the code.
 */
export default function SignEntryPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="rounded-lg border border-line bg-bg-surface p-6 shadow-sm">
        <div className="mb-5 flex justify-center">
          <Link
            href="/"
            aria-label="The Botss home"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          >
            <Logo variant="full" size="sm" />
          </Link>
        </div>
        <h1 className="text-lg font-semibold text-ink">Open the link from your email</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Use the button or link in the email you received. The page it opens asks for the
          6-digit code printed in the same email.
        </p>
      </div>
    </div>
  );
}
