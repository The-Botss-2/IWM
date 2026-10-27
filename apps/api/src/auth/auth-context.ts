import {
  type EffectivePermissions,
  resolveCompanyPermissions,
  resolveWorkspacePermissions,
} from '@botss/auth';
import { rawPrisma } from '@botss/database';
import type { AccountType, SystemRole, WorkspaceRole } from '@botss/shared-types';

/**
 * Everything AuthGuard needs to authorize a request, resolved in ONE stage of
 * parallel queries instead of the four serial stages it used to take
 * (user/org → user again + memberships + project memberships → user a third
 * time + overrides + the active membership).
 *
 * The rows are cached per user (see `AuthContextCache`), NOT per workspace:
 * the active workspace only selects among rows that are already loaded, so
 * switching `x-workspace-id` never needs another lookup and a forged header
 * can't mint cache keys.
 *
 * Pure: `buildAuthContext` reproduces `getUserOrgContext`,
 * `getSessionContext` and `loadEffectivePermissions` exactly, from the rows.
 */

/** A custom role, reduced to the fields `liveRole` reads. */
export interface AuthContextCustomRole {
  permissions: string[];
  deleted: boolean;
  scope: string;
  organizationId: string;
}

/** JSON-safe snapshot of the per-user rows. Dates are reduced to flags. */
export interface AuthContextRows {
  user: {
    systemRole: SystemRole;
    organizationId: string | null;
    accountType: AccountType;
    deleted: boolean;
    organization: { deleted: boolean; isActive: boolean } | null;
    customRole: AuthContextCustomRole | null;
  } | null;
  workspaceMemberships: Array<{
    workspaceId: string;
    role: string;
    workspaceOrganizationId: string | null;
    workspaceDeleted: boolean;
    customRole: AuthContextCustomRole | null;
  }>;
  projectMemberships: Array<{
    projectId: string;
    role: string;
    abilities: unknown;
    projectWorkspaceId: string;
    workspaceOrganizationId: string | null;
  }>;
  overrides: Array<{ permission: string; grant: boolean; workspaceId: string | null }>;
}

export interface UserOrgContext {
  systemRole: SystemRole;
  organizationId: string | null;
  accountType: AccountType;
  orgInactive: boolean;
  userDisabled: boolean;
}

export interface SessionContext {
  currentWorkspaceId: string | null;
  workspaceMemberships: Array<{ workspaceId: string; role: string }>;
  projectMemberships: Array<{
    projectId: string;
    workspaceId: string;
    role: string;
    abilities: unknown;
  }>;
}

export interface AuthContext {
  extras: UserOrgContext;
  session: SessionContext;
  permissions: EffectivePermissions;
}

const customRoleSelect = {
  select: { permissions: true, deletedAt: true, scope: true, organizationId: true },
} as const;

type CustomRoleRow = {
  permissions: string[];
  deletedAt: Date | null;
  scope: string;
  organizationId: string;
} | null;

function toCustomRole(r: CustomRoleRow): AuthContextCustomRole | null {
  return r
    ? {
        permissions: r.permissions,
        deleted: r.deletedAt !== null,
        scope: r.scope,
        organizationId: r.organizationId,
      }
    : null;
}

/**
 * Load the per-user rows. Four independent queries in parallel - the same
 * tables the old serial path read, with the duplicate `User` lookups folded
 * into one. rawPrisma on purpose (a soft-deleted user must be SEEN so it can
 * be refused, and the old helpers all read raw).
 */
export async function loadAuthContextRows(userId: string): Promise<AuthContextRows> {
  const [user, memberships, projectMemberships, overrides] = await Promise.all([
    rawPrisma.user.findUnique({
      where: { id: userId },
      select: {
        systemRole: true,
        organizationId: true,
        accountType: true,
        deletedAt: true,
        organization: { select: { deletedAt: true, isActive: true } },
        customRole: customRoleSelect,
      },
    }),
    rawPrisma.workspaceMembership.findMany({
      where: { userId },
      select: {
        workspaceId: true,
        role: true,
        workspace: { select: { organizationId: true, deletedAt: true } },
        customRole: customRoleSelect,
      },
    }),
    rawPrisma.projectMembership.findMany({
      where: { userId },
      select: {
        projectId: true,
        role: true,
        abilities: true,
        project: {
          select: {
            workspaceId: true,
            workspace: { select: { organizationId: true } },
          },
        },
      },
    }),
    // Every override of the user; the active workspace's subset is picked in
    // memory once the workspace is known (the old query filtered on it).
    rawPrisma.userPermissionOverride.findMany({
      where: { userId },
      select: { permission: true, grant: true, workspaceId: true },
    }),
  ]);

  return {
    user: user
      ? {
          systemRole: user.systemRole,
          organizationId: user.organizationId,
          accountType: user.accountType,
          deleted: user.deletedAt !== null,
          organization: user.organization
            ? {
                deleted: user.organization.deletedAt !== null,
                isActive: user.organization.isActive,
              }
            : null,
          customRole: toCustomRole(user.customRole),
        }
      : null,
    workspaceMemberships: memberships.map((m) => ({
      workspaceId: m.workspaceId,
      role: m.role,
      workspaceOrganizationId: m.workspace.organizationId,
      workspaceDeleted: m.workspace.deletedAt !== null,
      customRole: toCustomRole(m.customRole),
    })),
    projectMemberships: projectMemberships.map((p) => ({
      projectId: p.projectId,
      role: p.role,
      abilities: p.abilities,
      projectWorkspaceId: p.project.workspaceId,
      workspaceOrganizationId: p.project.workspace.organizationId,
    })),
    overrides,
  };
}

/** Resolve the request context from the per-user rows. Pure. */
export function buildAuthContext(
  rows: AuthContextRows,
  requestedWorkspaceId?: string,
): AuthContext {
  const user = rows.user;

  // --- getUserOrgContext -----------------------------------------------
  const extras: UserOrgContext = user
    ? {
        systemRole: user.systemRole,
        organizationId: user.organizationId,
        accountType: user.accountType,
        orgInactive:
          !!user.organization && (user.organization.deleted || user.organization.isActive === false),
        userDisabled: user.deleted,
      }
    : {
        systemRole: 'EMPLOYEE',
        organizationId: null,
        accountType: 'STAFF',
        orgInactive: false,
        userDisabled: true,
      };

  // --- getSessionContext -----------------------------------------------
  const orgId = user?.organizationId ?? null;
  const liveMemberships = rows.workspaceMemberships
    .filter((m) => !m.workspaceDeleted)
    .filter((m) => !orgId || m.workspaceOrganizationId === orgId);
  const wsMemberships = liveMemberships.map((m) => ({ workspaceId: m.workspaceId, role: m.role }));

  let currentWorkspaceId: string | null = null;
  if (requestedWorkspaceId && wsMemberships.some((m) => m.workspaceId === requestedWorkspaceId)) {
    currentWorkspaceId = requestedWorkspaceId;
  } else if (wsMemberships.length > 0) {
    currentWorkspaceId = wsMemberships[0]!.workspaceId;
  }

  const session: SessionContext = {
    currentWorkspaceId,
    workspaceMemberships: wsMemberships,
    projectMemberships: rows.projectMemberships
      .filter((p) => !orgId || p.workspaceOrganizationId === orgId)
      .map((p) => ({
        projectId: p.projectId,
        workspaceId: p.projectWorkspaceId,
        role: p.role,
        abilities: p.abilities,
      })),
  };

  // --- loadEffectivePermissions(userId, currentWorkspaceId) -------------
  let permissions: EffectivePermissions = { company: [], workspace: [] };
  if (user) {
    const overrides = rows.overrides.filter(
      (o) => o.workspaceId === null || (currentWorkspaceId !== null && o.workspaceId === currentWorkspaceId),
    );
    const liveRole = (
      r: AuthContextCustomRole | null,
      scope: 'COMPANY' | 'WORKSPACE',
    ): string[] | null =>
      r && !r.deleted && r.scope === scope && r.organizationId === user.organizationId
        ? r.permissions
        : null;
    const membership = currentWorkspaceId
      ? rows.workspaceMemberships.find((m) => m.workspaceId === currentWorkspaceId) ?? null
      : null;
    permissions = {
      company: resolveCompanyPermissions({
        systemRole: user.systemRole,
        customRolePermissions: liveRole(user.customRole, 'COMPANY'),
        overrides,
      }),
      workspace: membership
        ? resolveWorkspacePermissions({
            role: membership.role as WorkspaceRole,
            customRolePermissions: liveRole(membership.customRole, 'WORKSPACE'),
            overrides,
            workspaceId: currentWorkspaceId,
          })
        : [],
    };
  }

  return { extras, session, permissions };
}
