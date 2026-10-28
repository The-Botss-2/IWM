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
      <h1 className="text-ink text-lg font-semibold">Sign-ups are closed</h1>
      <p className="text-ink-muted text-sm">
        Individual accounts are created by an administrator. If you should have access, ask your
        workspace admin to add you.
      </p>
      <p className="text-ink-muted text-sm">
        Are you an organization?{' '}
        <Link
          href="/org-signup"
          className="text-brand-600 hover:text-brand-700 font-medium hover:underline"
        >
          Sign up now
        </Link>
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
