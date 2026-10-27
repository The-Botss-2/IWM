import { PageLoader } from '@/components/ui/loader';

/**
 * Default loading state for any (app) route that doesn't ship its own
 * `loading.tsx`. Rendered by Next.js between server-component fetches so
 * the user sees an immediate response when they navigate.
 */
export default function AppRouteLoading() {
  return <PageLoader label="Loading" />;
}
