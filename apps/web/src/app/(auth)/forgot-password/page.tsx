import Link from 'next/link';

/**
 * Self-serve password reset is disabled. The Botss is an admin-managed
 * platform - password changes go through the admin Users panel so that
 * webmail and CRM credentials stay in sync. Anyone who lands here (old
 * bookmark, stale link, search engine cache) gets a clear path back.
 */
export default function ForgotPasswordDisabledPage() {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-ink text-lg font-semibold">Password resets are admin-managed</h1>
      <p className="text-ink-muted text-sm">
        Ask your administrator to reset your password from the Users panel. Self-serve reset is
        disabled so that your CRM password stays in sync with your webmail.
      </p>
      <div className="pt-2">
        <Link
          href="/sign-in"
          className="bg-brand-600 hover:bg-brand-700 focus-visible:shadow-focus inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white focus-visible:outline-none focus-visible:ring-2"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
