import type { ReactNode } from 'react';

import { SupportExcludedGate } from '@/components/shell/support-excluded-gate';

export default function MailLayout({ children }: { children: ReactNode }) {
  return <SupportExcludedGate area="Mail">{children}</SupportExcludedGate>;
}
