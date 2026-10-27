'use client';

import type { ReactNode } from 'react';

import { CallProviderShell } from '@/components/chat/call-provider-shell';
import { GlobalRealtime } from '@/components/shell/global-realtime';
import { useActiveSupportSession } from '@/hooks/use-support-access';

/**
 * Chat socket, presence, push, calls and the notification dispatcher for the
 * signed-in user. Not mounted in a read only support session: those belong
 * to the platform operator's own account, and the API refuses chat,
 * notifications and calls under the support banner anyway.
 */
export function AppRealtime({ children }: { children: ReactNode }) {
  const support = useActiveSupportSession();
  if (support) return <>{children}</>;
  return (
    <CallProviderShell>
      {children}
      <GlobalRealtime />
    </CallProviderShell>
  );
}
