import Link from 'next/link';

/**
 * Self-serve password reset is disabled. See `/forgot-password` for the
 * matching notice. A landing page (not a redirect) so any stale reset
 * link the user clicks goes somewhere informative.
 */
export default function ResetPasswordDisabledPage() {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-ink text-lg font-semibold">This reset link no longer works</h1>
      <p className="text-ink-muted text-sm">
        Password resets are now handled by your administrator. Ask them to set a new password for
        you from the Users panel.
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
