import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { PortalGate } from '@/components/portal/portal-gate';
import { PortalShell } from '@/components/portal/portal-shell';

export const metadata: Metadata = {
  title: 'Client portal',
  robots: { index: false, follow: false },
};

/**
 * The client portal: people at our clients see their own projects, shared
 * documents, signature requests and (the main contact) billing.
 *
 * Deliberately not the internal app shell: no `GlobalRealtime`, no command
 * palette, no CASL `AbilityProvider`. A CLIENT account is refused on every
 * internal route, so mounting any of those would only fire failing requests.
 */
export default function PortalLayout({ children }: { children: ReactNode }) {
  return (
    <PortalGate>
      <PortalShell>{children}</PortalShell>
    </PortalGate>
  );
}
