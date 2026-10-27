import { ForbiddenException } from '@nestjs/common';

/**
 * Privilege tiers for admin user management. Company `users.manage` can be
 * granted through a custom role to someone who is not an ADMIN, so holding
 * it must not let them act on (or mint) accounts above their own tier.
 */
export function systemRoleRank(role: string | null | undefined): number {
  if (role === 'SUPER_ADMIN') return 3;
  if (role === 'ADMIN') return 2;
  return 1;
}

export interface AdminEditCheck {
  actorId: string;
  actorRole: string | null | undefined;
  targetId: string;
  targetRole: string;
  /** The requested systemRole, when the edit sets one. */
  newRole?: string | undefined;
  /** Company `roles.manage` on the actor. */
  actorHasRolesManage: boolean;
}

/**
 * Rules for editing (including password resets) and removing a user:
 *
 * 1. The target may not outrank the actor: an ADMIN / SUPER_ADMIN target
 *    needs an actor of at least that tier. A non-admin with `users.manage`
 *    could otherwise reset an admin's password and sign in as them.
 * 2. Nobody changes their own systemRole.
 * 3. Changing anyone's systemRole needs `roles.manage`, and the new role may
 *    not outrank the actor.
 *
 * Org boundaries and the SUPER_ADMIN/root-org rules are checked separately.
 */
export function assertMayAdministerUser(check: AdminEditCheck): void {
  const actorRank = systemRoleRank(check.actorRole);
  if (systemRoleRank(check.targetRole) > actorRank) {
    throw new ForbiddenException({
      title: 'Target has higher privileges',
      status: 403,
      detail: 'You cannot change an account with a higher role than your own.',
    });
  }
  const roleChanging = check.newRole !== undefined && check.newRole !== check.targetRole;
  if (!roleChanging) return;
  if (check.actorId === check.targetId) {
    throw new ForbiddenException({
      title: 'Cannot change your own role',
      status: 403,
      detail: 'Ask another administrator to change your role.',
    });
  }
  if (!check.actorHasRolesManage) {
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'Changing a company role requires the Manage roles permission.',
    });
  }
  if (systemRoleRank(check.newRole) > actorRank) {
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'You cannot grant a role higher than your own.',
    });
  }
}

/**
 * Same-organization rule for every admin action on a user: every admin,
 * SUPER_ADMIN included, manages users of their own organization only. Both
 * orgs must be set and equal (two nulls never match).
 */
export function assertSameOrg(
  actorOrgId: string | null | undefined,
  targetOrgId: string | null | undefined,
): asserts actorOrgId is string {
  if (!actorOrgId || !targetOrgId || actorOrgId !== targetOrgId) {
    throw new ForbiddenException({
      title: 'User is outside your organization',
      status: 403,
    });
  }
}
