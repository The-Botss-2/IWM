import Link from 'next/link';

/**
 * Public sign-up is disabled. The Botss CRM is admin-controlled: new
 * accounts are created from the admin Users panel. Anyone who lands here
 * (bookmark, stale link, search engine cache) gets a clear explanation
 * and a path back to sign-in.
 */
export default function SignUpDisabledPage() {
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-lg font-semibold text-ink">Sign-ups are closed</h1>
      <p className="text-sm text-ink-muted">
        Individual accounts are created by an administrator. If you should
        have access, ask your workspace admin to add you.
      </p>
      <p className="text-sm text-ink-muted">
        Are you an organization?{' '}
        <Link
          href="/org-signup"
          className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
        >
          Sign up now
        </Link>
      </p>
      <div className="pt-2">
        <Link
          href="/sign-in"
          className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
