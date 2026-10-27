import type { ReactNode } from 'react';

import { SettingsShell } from '@/components/shell/settings-shell';

/**
 * Settings shell. The sidebar (settings + role-gated admin tools) lives in
 * SettingsShell, shared with the /admin routes so the nav never swaps out.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
