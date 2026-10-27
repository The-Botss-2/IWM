'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { PortalClientSummary, PortalMe } from '@botss/shared-types';

import { useResolvedPortalClient } from '@/hooks/use-portal';

interface PortalContextValue {
  me: PortalMe;
  /** The client the header and nav are showing. See `useResolvedPortalClient`. */
  activeClient: PortalClientSummary | null;
}

const PortalContext = createContext<PortalContextValue | null>(null);

/** Mounted by `PortalGate` once `portal.me()` has loaded. */
export function PortalProvider({ me, children }: { me: PortalMe; children: ReactNode }) {
  const activeClient = useResolvedPortalClient(me);
  const value = useMemo(() => ({ me, activeClient }), [me, activeClient]);
  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

function usePortalContext(): PortalContextValue {
  const ctx = useContext(PortalContext);
  if (!ctx) throw new Error('Portal hooks must be used inside <PortalProvider>.');
  return ctx;
}

/** The signed-in client person and every client they can reach. */
export function usePortalMe(): PortalMe {
  return usePortalContext().me;
}

/**
 * One of the person's clients by id, or null when they are not a contact of
 * it. A UX check only: the API answers 404 for a client that is not theirs.
 */
export function usePortalClient(clientId: string | null | undefined): PortalClientSummary | null {
  const me = usePortalMe();
  return useMemo(
    () => (clientId ? (me.clients.find((c) => c.id === clientId) ?? null) : null),
    [me, clientId],
  );
}

/** The client the portal is showing, for pages outside a client such as Account. */
export function usePortalActiveClient(): PortalClientSummary | null {
  return usePortalContext().activeClient;
}
