import {
  type EffectivePermissions,
  presetPermissions,
  SUPPORT_SESSION_PERMISSIONS,
  resolveCompanyPermissions,
  resolveWorkspacePermissions,
} from '@botss/auth';
import { rawPrisma } from '@botss/database';
import type { SystemRole, WorkspaceRole } from '@botss/shared-types';

import type { RequestExtensions } from '../guards/auth.guard';
import { requestAuthFor, supportScopeFor } from '../request-context';

/**
 * Resolve a user's effective permissions: company role (custom role or the
 * systemRole preset) plus company overrides, and the role (custom or preset)
 * plus overrides in ONE workspace. Pure resolution lives in
 * `@botss/auth/permissions`; this only fetches.
 *
 * AuthGuard calls this once per request and stores the result on
 * `req.permissions`; services that only have a user id call it directly.
 */
export async function loadEffectivePermissions(
  userId: string,
  workspaceId: string | null,
): Promise<EffectivePermissions> {
  // Read only support session: the operator's rows in the database describe
  // their own root organization, never the granted one. Answer with the
  // support permissions instead, workspace keys only for a granted workspace.
  const support = supportScopeFor(userId);
  if (support) {
    return {
      company: [...SUPPORT_SESSION_PERMISSIONS.company],
      workspace:
        workspaceId && support.workspaceIds.includes(workspaceId)
          ? [...SUPPORT_SESSION_PERMISSIONS.workspace]
          : [],
    };
  }
  const [user, overrides, membership] = await Promise.all([
    rawPrisma.user.findUnique({
      where: { id: userId },
      select: {
        systemRole: true,
        organizationId: true,
        customRole: {
          select: { permissions: true, deletedAt: true, scope: true, organizationId: true },
        },
      },
    }),
    rawPrisma.userPermissionOverride.findMany({
      where: {
        userId,
        OR: [{ workspaceId: null }, ...(workspaceId ? [{ workspaceId }] : [])],
      },
      select: { permission: true, grant: true, workspaceId: true },
    }),
    workspaceId
      ? rawPrisma.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId, userId } },
          select: {
            role: true,
            workspace: { select: { organizationId: true } },
            customRole: {
              select: { permissions: true, deletedAt: true, scope: true, organizationId: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  if (!user) return { company: [], workspace: [] };
  // A membership into a workspace outside the user's organization (or any
  // membership of an org-less user) counts as none. Stricter than AuthGuard
  // for org-less users, matching orgWorkspaceMembership.
  const liveMembership =
    membership && membership.workspace.organizationId === user.organizationId ? membership : null;

  // A custom role only counts while it is live, of the right scope and in the
  // user's own org. Anything else falls back to the preset.
  const liveRole = (
    r:
      | { permissions: string[]; deletedAt: Date | null; scope: string; organizationId: string }
      | null
      | undefined,
    scope: 'COMPANY' | 'WORKSPACE',
  ): string[] | null =>
    r && r.deletedAt === null && r.scope === scope && r.organizationId === user.organizationId
      ? r.permissions
      : null;

  return {
    company: resolveCompanyPermissions({
      systemRole: user.systemRole,
      customRolePermissions: liveRole(user.customRole, 'COMPANY'),
      overrides,
    }),
    workspace: liveMembership
      ? resolveWorkspacePermissions({
          role: liveMembership.role,
          customRolePermissions: liveRole(liveMembership.customRole, 'WORKSPACE'),
          overrides,
          workspaceId,
        })
      : [],
  };
}

/** The request's effective permissions, falling back to presets. */
export function requestPermissions(req: RequestExtensions): EffectivePermissions {
  if (req.permissions) return req.permissions;
  const active = req.workspaceId ?? null;
  return presetPermissions({
    systemRole: (req.user?.systemRole ?? 'EMPLOYEE') as SystemRole,
    workspaceMemberships: (req.workspaceMemberships ?? [])
      .filter((m) => active !== null && m.workspaceId === active)
      .map((m) => ({ role: m.role as WorkspaceRole })),
  });
}

/** Company permission check for a user id (services without the request). */
export async function userHasCompanyPermission(
  userId: string,
  ...keys: string[]
): Promise<boolean> {
  // Company permissions don't depend on the active workspace (workspace
  // overrides are ignored by `resolveCompanyPermissions`), so the set AuthGuard
  // already resolved for this request's user is the same answer.
  const company =
    requestAuthFor(userId)?.permissions.company ??
    (await loadEffectivePermissions(userId, null)).company;
  return keys.some((k) => company.includes(k));
}
