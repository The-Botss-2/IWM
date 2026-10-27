'use client';

import { useMemo } from 'react';
import { presetPermissions, type EffectivePermissions } from '@botss/auth/ability';
import type { WorkspaceRole } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';

export interface PermissionsView extends EffectivePermissions {
  /** Session still loading. */
  checking: boolean;
  /** Held in either scope. */
  has: (key: string) => boolean;
  /** Any of the keys held in either scope. */
  hasAny: (...keys: string[]) => boolean;
  /** Org admin: administers every workspace. */
  isOrgAdmin: boolean;
  isHr: boolean;
  isFinance: boolean;
  canManageRoles: boolean;
}

/**
 * The signed-in user's effective permissions (company + active workspace), as
 * resolved by the API on /auth/me. Falls back to the systemRole / membership
 * presets for an older API build. A UX hint only: the server enforces.
 */
export function usePermissions(): PermissionsView {
  const session = useSessionContext();
  const data = session.data;
  return useMemo(() => {
    const eff: EffectivePermissions = data?.permissions
      ? data.permissions
      : data
        ? presetPermissions({
            systemRole: data.user.systemRole,
            workspaceMemberships: data.workspaceMemberships
              .filter((m) => m.workspaceId === data.currentWorkspaceId)
              .map((m) => ({ role: m.role as WorkspaceRole })),
          })
        : { company: [], workspace: [] };
    const has = (k: string) => eff.company.includes(k) || eff.workspace.includes(k);
    const hasAny = (...keys: string[]) => keys.some(has);
    return {
      ...eff,
      checking: session.isPending,
      has,
      hasAny,
      isOrgAdmin: eff.company.includes('workspaces.admin_all'),
      isHr: eff.company.includes('hr.attendance') || eff.company.includes('hr.leave.approve'),
      isFinance: eff.company.includes('finance.view') || eff.company.includes('finance.manage'),
      canManageRoles: eff.company.includes('roles.manage'),
    };
  }, [data, session.isPending]);
}
