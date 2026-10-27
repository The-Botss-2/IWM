import { PageLoader } from '@/components/ui/loader';

/** Default loading state for portal routes that don't ship their own. */
export default function PortalRouteLoading() {
  return <PageLoader label="Loading" />;
}
