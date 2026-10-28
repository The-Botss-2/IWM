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
      <div className="border-line bg-bg-surface rounded-lg border p-6 shadow-sm">
        <div className="mb-5 flex justify-center">
          <Link
            href="/"
            aria-label="The Botss home"
            className="focus-visible:shadow-focus rounded focus-visible:outline-none focus-visible:ring-2"
          >
            <Logo variant="full" size="sm" />
          </Link>
        </div>
        <h1 className="text-ink text-lg font-semibold">Open the link from your email</h1>
        <p className="text-ink-muted mt-2 text-sm">
          Use the button or link in the email you received. The page it opens asks for the 6-digit
          code printed in the same email.
        </p>
      </div>
    </div>
  );
}
