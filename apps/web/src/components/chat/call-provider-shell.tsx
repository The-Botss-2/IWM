'use client';

import type { ReactNode } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { CallProvider } from '@/components/chat/call-context';

/**
 * Thin wrapper that reads the signed-in user from the SessionGate context
 * and hands it to `<CallProvider>`. Split out so the app-shell layout
 * stays composed of pure-import components and doesn't have to be marked
 * `'use client'` just to read the session.
 */
export function CallProviderShell({ children }: { children: ReactNode }) {
  const session = useSessionContext();
  const userId = session.data?.user?.id ?? '';
  return <CallProvider userId={userId}>{children}</CallProvider>;
}
