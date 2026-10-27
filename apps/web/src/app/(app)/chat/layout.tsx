import type { ReactNode } from 'react';

import { ChatShell } from '@/components/chat/chat-shell';
import { SupportExcludedGate } from '@/components/shell/support-excluded-gate';

export default function ChatLayout({ children }: { children: ReactNode }) {
  return (
    <SupportExcludedGate area="Chat">
      <ChatShell>{children}</ChatShell>
    </SupportExcludedGate>
  );
}
