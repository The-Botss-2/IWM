import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Developer-only routes. Gated by `NODE_ENV !== 'production'` for now - when
 * we add a `User.isDeveloper` boolean to the schema, this layout can fall
 * back to a session check. Until then, the route is simply unreachable in
 * production builds (returns the standard not-found page).
 *
 * Sidebar deliberately not mounted - this section renders its own intra-page
 * navigation and benefits from a clean canvas.
 */
export default function DeveloperLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return <div className="min-h-screen bg-bg-subtle">{children}</div>;
}
