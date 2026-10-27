'use client';

import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { SettingsShell } from '@/components/shell/settings-shell';
import { PageLoader } from '@/components/ui/loader';
import { usePermissions } from '@/hooks/use-permissions';

/**
 * Admin routes render inside the shared SettingsShell (one unified sidebar with
 * /settings), but stay system-admin gated: non-privileged users are bounced to
 * /home so they don't sit on an admin URL waiting for a 403. The server still
 * enforces access at each endpoint - this is the UX shortcut.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const session = useSessionContext();
  const perms = usePermissions();
  // Org admins run the panel; HR is admitted for attendance + timesheets.
  const isPrivileged =
    perms.isOrgAdmin || perms.isHr || perms.hasAny('users.manage', 'audit.view', 'roles.manage');

  useEffect(() => {
    if (session.isPending) return;
    if (!isPrivileged) router.replace('/home');
  }, [isPrivileged, router, session.isPending]);

  if (session.isPending || !isPrivileged) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <PageLoader label="Loading admin tools" />
      </div>
    );
  }

  return <SettingsShell>{children}</SettingsShell>;
}
