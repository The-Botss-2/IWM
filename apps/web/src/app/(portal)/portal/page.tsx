'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { usePortalMe } from '@/components/portal/portal-context';
import { PortalNoAccess } from '@/components/portal/portal-states';
import { PageLoader } from '@/components/ui/loader';
import { portalHref } from '@/hooks/use-portal';

/** `/portal` has no page of its own: open the person's first client. */
export default function PortalIndexPage() {
  const router = useRouter();
  const me = usePortalMe();
  const firstId = me.clients[0]?.id;

  useEffect(() => {
    if (firstId) router.replace(portalHref(firstId));
  }, [firstId, router]);

  // The gate already covers this; kept so the page is safe on its own.
  if (!firstId) return <PortalNoAccess />;
  return <PageLoader label="Opening your portal" />;
}
