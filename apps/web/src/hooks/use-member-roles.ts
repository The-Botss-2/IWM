'use client';

import type { RoleDto, WorkspaceMembershipWithUser, WorkspaceRole } from '@botss/shared-types';

/**
 * Role-select plumbing for the workspace members screen: one select lists the
 * built-in roles and the org's custom workspace roles.
 */

const CUSTOM_PREFIX = 'custom:';

/** OWNER / ADMIN / MEMBER / VIEWER preset key for a membership enum value. */
export function workspacePresetKeyOf(role: WorkspaceRole): string {
  if (role === 'OWNER' || role === 'ADMIN') return role;
  if (role === 'MEMBER' || role === 'MANAGER' || role === 'EDITOR') return 'MEMBER';
  return 'VIEWER';
}

/** Current select value for a member. */
export function memberRoleValue(m: WorkspaceMembershipWithUser): string {
  return m.customRoleId ? `${CUSTOM_PREFIX}${m.customRoleId}` : m.role;
}

/** The update payload for a chosen select value. */
export function memberRoleUpdate(
  value: string,
  current: WorkspaceRole,
): { role: Exclude<WorkspaceRole, 'CLIENT'>; customRoleId: string | null } {
  if (value.startsWith(CUSTOM_PREFIX)) {
    // A custom role keeps a valid base enum underneath (legacy CLIENT moves to MEMBER).
    const base = current === 'CLIENT' ? 'MEMBER' : current;
    return { role: base, customRoleId: value.slice(CUSTOM_PREFIX.length) };
  }
  return { role: value as Exclude<WorkspaceRole, 'CLIENT'>, customRoleId: null };
}

export function customRoleOptions(roles: RoleDto[] | undefined): { value: string; label: string }[] {
  return (roles ?? [])
    .filter((r) => !r.preset)
    .map((r) => ({ value: `${CUSTOM_PREFIX}${r.id}`, label: r.name }));
}

const COMPANY_PRESET_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  HR: 'HR',
  FINANCE: 'Finance',
  PROJECT_MANAGER: 'Project manager',
  EMPLOYEE: 'Employee',
};

/** Human label for the member's company role (custom role names pass through). */
export function companyRoleLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return COMPANY_PRESET_LABEL[value] ?? value;
}
