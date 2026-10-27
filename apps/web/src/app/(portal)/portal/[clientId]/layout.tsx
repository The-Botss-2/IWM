'use client';

import { use, type ReactNode } from 'react';

import { usePortalClient } from '@/components/portal/portal-context';
import { PortalUnavailable } from '@/components/portal/portal-states';

/**
 * Everything under `/portal/[clientId]` belongs to one client. When the id
 * is not one of the person's clients (an old link, or access that changed),
 * say so here instead of letting each page take a 404 from the API.
 */
export default function PortalClientLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = use(params);
  const client = usePortalClient(clientId);

  if (!client) {
    return (
      <PortalUnavailable
        title="We couldn't find that client"
        description="The link may be out of date, or your access to this client has changed."
        href="/portal"
        linkLabel="Back to your portal"
      />
    );
  }
  return <>{children}</>;
}
