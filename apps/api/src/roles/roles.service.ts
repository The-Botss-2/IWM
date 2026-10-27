import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  type EffectivePermissions,
  PERMISSION_CATALOG,
  WORKSPACE_PRESETS,
  type WorkspacePresetKey,
  canAssignWorkspacePermissions,
  isPermissionKey,
  resolveCompanyPermissions,
} from '@botss/auth';
import type {
  CreateRoleInput,
  ListRolesResponse,
  PermissionCatalogResponse,
  RoleDto,
  SetCompanyRoleInput,
  SetPermissionOverridesInput,
  SystemRole,
  UpdateRoleInput,
  UserPermissionsResponse,
} from '@botss/shared-types';

import { AuditLogService } from '../audit-log/audit-log.service';
import { loadEffectivePermissions } from '../common/permissions/effective-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';

/** Who is acting, as resolved by AuthGuard for this request. */
export interface RolesActor {
  userId: string;
  organizationId: string | null;
  activeWorkspaceId: string | null;
  permissions: EffectivePermissions;
}

const COMPANY_PRESET_LABELS: Record<SystemRole, string> = {
  SUPER_ADMIN: 'Super admin',
  ADMIN: 'Admin',
  HR: 'HR',
  FINANCE: 'Finance',
  PROJECT_MANAGER: 'Project manager',
  EMPLOYEE: 'Employee',
};
const COMPANY_PRESET_ORDER: SystemRole[] = [
  'SUPER_ADMIN',
  'ADMIN',
  'HR',
  'FINANCE',
  'PROJECT_MANAGER',
  'EMPLOYEE',
];
const WORKSPACE_PRESET_ORDER: WorkspacePresetKey[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
const WORKSPACE_PRESET_LABELS: Record<WorkspacePresetKey, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};
/** Enum values that resolve to each workspace preset. */
const WORKSPACE_PRESET_ENUMS: Record<WorkspacePresetKey, string[]> = {
  OWNER: ['OWNER'],
  ADMIN: ['ADMIN'],
  MEMBER: ['MEMBER', 'MANAGER', 'EDITOR'],
  VIEWER: ['VIEWER', 'CLIENT'],
};

/** A company role carrying any of these makes its holder an admin. */
const ADMIN_LEVEL_PERMISSIONS: ReadonlySet<string> = new Set(['users.manage', 'roles.manage']);

type Tx = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Optional() private readonly alerts?: SecurityAlertsService,
  ) {}

  catalog(): PermissionCatalogResponse {
    return { permissions: PERMISSION_CATALOG.map((p) => ({ ...p })) };
  }

  // ─── Roles ─────────────────────────────────────────────────────────────

  async list(actor: RolesActor): Promise<ListRolesResponse> {
    const orgId = this.requireOrg(actor);
    const staffInOrg = { organizationId: orgId, accountType: 'STAFF' as const, deletedAt: null };
    const [custom, sysCounts, customUserCounts, wsCounts, customWsCounts] = await Promise.all([
      this.prisma.client.role.findMany({
        where: { organizationId: orgId },
        orderBy: { name: 'asc' },
      }),
      this.prisma.client.user.groupBy({
        by: ['systemRole'],
        where: { ...staffInOrg, customRoleId: null },
        _count: { _all: true },
      }),
      this.prisma.client.user.groupBy({
        by: ['customRoleId'],
        where: { ...staffInOrg, customRoleId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.client.workspaceMembership.groupBy({
        by: ['role'],
        where: { customRoleId: null, workspace: { organizationId: orgId, deletedAt: null } },
        _count: { _all: true },
      }),
      this.prisma.client.workspaceMembership.groupBy({
        by: ['customRoleId'],
        where: { customRoleId: { not: null }, workspace: { organizationId: orgId, deletedAt: null } },
        _count: { _all: true },
      }),
    ]);
    const sysCount = (r: SystemRole) =>
      sysCounts.find((c) => c.systemRole === r)?._count._all ?? 0;
    const customCount = new Map<string, number>();
    for (const c of [...customUserCounts, ...customWsCounts]) {
      if (c.customRoleId) customCount.set(c.customRoleId, c._count._all);
    }

    const companyPresets: RoleDto[] = COMPANY_PRESET_ORDER.map((key) => ({
      id: `preset:${key}`,
      scope: 'COMPANY',
      name: COMPANY_PRESET_LABELS[key],
      description: null,
      permissions: resolveCompanyPermissions({ systemRole: key }),
      basePreset: null,
      preset: true,
      presetKey: key,
      locked: true,
      memberCount: sysCount(key),
    }));
    const workspacePresets: RoleDto[] = WORKSPACE_PRESET_ORDER.map((key) => ({
      id: `preset:${key}`,
      scope: 'WORKSPACE',
      name: WORKSPACE_PRESET_LABELS[key],
      description: null,
      permissions: [...WORKSPACE_PRESETS[key]].sort(),
      basePreset: null,
      preset: true,
      presetKey: key,
      locked: true,
      memberCount: wsCounts
        .filter((c) => WORKSPACE_PRESET_ENUMS[key].includes(c.role))
        .reduce((n, c) => n + c._count._all, 0),
    }));
    const toDto = (r: (typeof custom)[number]): RoleDto => ({
      id: r.id,
      scope: r.scope,
      name: r.name,
      description: r.description,
      permissions: [...r.permissions].sort(),
      basePreset: r.basePreset,
      preset: false,
      presetKey: null,
      locked: false,
      memberCount: customCount.get(r.id) ?? 0,
    });
    return {
      company: [...companyPresets, ...custom.filter((r) => r.scope === 'COMPANY').map(toDto)],
      workspace: [...workspacePresets, ...custom.filter((r) => r.scope === 'WORKSPACE').map(toDto)],
    };
  }

  async create(actor: RolesActor, input: CreateRoleInput): Promise<RoleDto> {
    const orgId = this.requireRolesManager(actor);
    const permissions = this.validatePermissions(input.scope, input.permissions);
    const role = await this.prisma.client.role.create({
      data: {
        organizationId: orgId,
        scope: input.scope,
        name: input.name,
        description: input.description ?? null,
        permissions,
        basePreset: input.basePreset ?? null,
      },
    });
    this.log(orgId, actor, 'role.create', `role:${role.id}`, {
      name: role.name,
      scope: role.scope,
      permissions,
    });
    return {
      id: role.id,
      scope: role.scope,
      name: role.name,
      description: role.description,
      permissions,
      basePreset: role.basePreset,
      preset: false,
      presetKey: null,
      locked: false,
      memberCount: 0,
    };
  }

  async update(actor: RolesActor, id: string, input: UpdateRoleInput): Promise<RoleDto> {
    const orgId = this.requireRolesManager(actor);
    const existing = await this.findOwnRole(orgId, id);
    const permissions =
      input.permissions !== undefined
        ? this.validatePermissions(existing.scope, input.permissions)
        : existing.permissions;
    const role = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          permissions,
        },
      });
      if (existing.scope === 'COMPANY') await this.assertRolesManagerRemains(tx, orgId);
      return updated;
    });
    this.log(orgId, actor, 'role.update', `role:${id}`, {
      name: role.name,
      from: existing.permissions,
      to: permissions,
    });
    const count = await this.memberCount(id);
    return {
      id: role.id,
      scope: role.scope,
      name: role.name,
      description: role.description,
      permissions: [...permissions].sort(),
      basePreset: role.basePreset,
      preset: false,
      presetKey: null,
      locked: false,
      memberCount: count,
    };
  }

  async remove(actor: RolesActor, id: string): Promise<void> {
    const orgId = this.requireRolesManager(actor);
    const existing = await this.findOwnRole(orgId, id);
    await this.prisma.client.$transaction(async (tx) => {
      // Holders fall back to their preset (systemRole / membership role).
      await tx.user.updateMany({ where: { customRoleId: id }, data: { customRoleId: null } });
      await tx.workspaceMembership.updateMany({
        where: { customRoleId: id },
        data: { customRoleId: null },
      });
      await tx.role.update({ where: { id }, data: { deletedAt: new Date() } });
      if (existing.scope === 'COMPANY') await this.assertRolesManagerRemains(tx, orgId);
    });
    this.log(orgId, actor, 'role.delete', `role:${id}`, { name: existing.name });
  }

  // ─── Per-user assignment ───────────────────────────────────────────────

  async getUserPermissions(
    actor: RolesActor,
    userId: string,
    workspaceId: string | undefined,
  ): Promise<UserPermissionsResponse> {
    const orgId = this.requireOrg(actor);
    const target = await this.findOrgUser(orgId, userId);
    const wsId = workspaceId ?? null;
    if (!actor.permissions.company.includes('roles.manage')) {
      // Workspace managers may read a member of THEIR active workspace only.
      if (
        !wsId ||
        wsId !== actor.activeWorkspaceId ||
        !actor.permissions.workspace.includes('members.manage')
      ) {
        throw this.forbidden('You can not view this person\'s permissions.');
      }
    }
    if (wsId) await this.assertWorkspaceInOrg(orgId, wsId);
    const overrides = await this.prisma.client.userPermissionOverride.findMany({
      where: { userId, OR: [{ workspaceId: null }, ...(wsId ? [{ workspaceId: wsId }] : [])] },
      select: { permission: true, grant: true, workspaceId: true },
      orderBy: { permission: 'asc' },
    });
    return {
      userId,
      systemRole: target.systemRole,
      customRoleId: target.customRoleId,
      companyOverrides: overrides
        .filter((o) => o.workspaceId === null)
        .map(({ permission, grant }) => ({ permission, grant })),
      workspaceOverrides: overrides
        .filter((o) => wsId !== null && o.workspaceId === wsId)
        .map(({ permission, grant }) => ({ permission, grant })),
      workspaceId: wsId,
      effective: await loadEffectivePermissions(userId, wsId),
    };
  }

  async setCompanyRole(
    actor: RolesActor,
    userId: string,
    input: SetCompanyRoleInput,
  ): Promise<UserPermissionsResponse> {
    const orgId = this.requireRolesManager(actor);
    const target = await this.findOrgUser(orgId, userId);
    let grantsAdmin = false;
    if (input.customRoleId) {
      const role = await this.findOwnRole(orgId, input.customRoleId);
      if (role.scope !== 'COMPANY') {
        throw new BadRequestException({ title: 'Not a company role', status: 400 });
      }
      grantsAdmin = role.permissions.some((p) => ADMIN_LEVEL_PERMISSIONS.has(p));
    }
    await this.prisma.client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { customRoleId: input.customRoleId } });
      await this.assertRolesManagerRemains(tx, orgId);
    });
    this.log(orgId, actor, 'user.company_role', `user:${userId}`, {
      from: target.customRoleId,
      to: input.customRoleId,
      systemRole: target.systemRole,
    });
    if (grantsAdmin && input.customRoleId !== target.customRoleId) {
      // The custom role's name is tenant content, so the alert says CUSTOM.
      void this.alerts?.recordNewAdmin({
        organizationId: orgId,
        actorUserId: actor.userId,
        userId,
        scope: 'system',
        role: 'CUSTOM',
      });
    }
    return this.getUserPermissions(actor, userId, undefined);
  }

  async setOverrides(
    actor: RolesActor,
    userId: string,
    input: SetPermissionOverridesInput,
  ): Promise<UserPermissionsResponse> {
    const orgId = this.requireOrg(actor);
    await this.findOrgUser(orgId, userId);
    const scope = input.workspaceId ? 'workspace' : 'company';
    const keys = input.overrides.map((o) => o.permission);
    for (const k of keys) {
      if (!isPermissionKey(k, scope)) {
        throw new BadRequestException({
          title: 'Unknown permission',
          status: 400,
          detail: `"${k}" is not a ${scope} permission.`,
        });
      }
    }
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException({ title: 'Duplicate permission', status: 400 });
    }

    const isRolesManager = actor.permissions.company.includes('roles.manage');
    if (!input.workspaceId) {
      if (!isRolesManager) throw this.forbidden('Only role managers can change company permissions.');
    } else {
      await this.assertWorkspaceInOrg(orgId, input.workspaceId);
      const member = await this.prisma.client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: input.workspaceId, userId } },
        select: { id: true },
      });
      if (!member) {
        throw new BadRequestException({ title: 'Not a member of this workspace', status: 400 });
      }
      if (!isRolesManager) {
        if (input.workspaceId !== actor.activeWorkspaceId) {
          throw this.forbidden('You can only change permissions in your active workspace.');
        }
        if (userId === actor.userId) {
          throw this.forbidden('You can not change your own permissions.');
        }
        const verdict = canAssignWorkspacePermissions(actor.permissions, keys);
        if (!verdict.ok) throw this.forbidden(verdict.reason);
      }
    }

    const before = await this.prisma.client.userPermissionOverride.findMany({
      where: { userId, workspaceId: input.workspaceId },
      select: { permission: true, grant: true },
    });
    await this.prisma.client.$transaction(async (tx) => {
      await tx.userPermissionOverride.deleteMany({
        where: { userId, workspaceId: input.workspaceId },
      });
      if (input.overrides.length > 0) {
        await tx.userPermissionOverride.createMany({
          data: input.overrides.map((o) => ({
            userId,
            permission: o.permission,
            grant: o.grant,
            workspaceId: input.workspaceId,
            createdById: actor.userId,
          })),
        });
      }
      if (!input.workspaceId) await this.assertRolesManagerRemains(tx, orgId);
    });
    this.log(orgId, actor, 'user.permission_overrides', `user:${userId}`, {
      workspaceId: input.workspaceId,
      from: before,
      to: input.overrides,
    });
    return this.getUserPermissions(
      actor,
      userId,
      input.workspaceId ?? undefined,
    );
  }

  // ─── Guardrails ────────────────────────────────────────────────────────

  /**
   * At least one person in the org must keep `roles.manage`, or nobody could
   * ever fix the roles again. Runs inside the write's transaction so a
   * violating change rolls back.
   */
  private async assertRolesManagerRemains(tx: Tx, orgId: string): Promise<void> {
    const candidates = await tx.user.findMany({
      where: {
        organizationId: orgId,
        accountType: 'STAFF',
        deletedAt: null,
        OR: [
          { systemRole: { in: ['ADMIN', 'SUPER_ADMIN'] } },
          { customRoleId: { not: null } },
          { permissionOverrides: { some: { permission: 'roles.manage', workspaceId: null } } },
        ],
      },
      select: {
        systemRole: true,
        customRole: { select: { permissions: true, deletedAt: true, scope: true } },
        permissionOverrides: {
          where: { workspaceId: null },
          select: { permission: true, grant: true, workspaceId: true },
        },
      },
    });
    const anyone = candidates.some((u) =>
      resolveCompanyPermissions({
        systemRole: u.systemRole,
        customRolePermissions:
          u.customRole && u.customRole.deletedAt === null && u.customRole.scope === 'COMPANY'
            ? u.customRole.permissions
            : null,
        overrides: u.permissionOverrides,
      }).includes('roles.manage'),
    );
    if (!anyone) {
      throw new ConflictException({
        title: 'Would lock everyone out',
        status: 409,
        detail: 'At least one person must keep the "Manage roles" permission.',
        code: 'roles-lockout',
      });
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private requireOrg(actor: RolesActor): string {
    if (!actor.organizationId) {
      throw this.forbidden('Your account is not attached to an organization.');
    }
    return actor.organizationId;
  }

  private requireRolesManager(actor: RolesActor): string {
    const orgId = this.requireOrg(actor);
    if (!actor.permissions.company.includes('roles.manage')) {
      throw this.forbidden('Managing roles requires the "Manage roles" permission.');
    }
    return orgId;
  }

  private validatePermissions(scope: 'COMPANY' | 'WORKSPACE', permissions: string[]): string[] {
    const s = scope === 'COMPANY' ? 'company' : 'workspace';
    for (const p of permissions) {
      if (!isPermissionKey(p, s)) {
        throw new BadRequestException({
          title: 'Unknown permission',
          status: 400,
          detail: `"${p}" is not a ${s} permission.`,
        });
      }
    }
    return [...new Set(permissions)].sort();
  }

  private async findOwnRole(orgId: string, id: string) {
    const role = await this.prisma.client.role.findFirst({ where: { id, organizationId: orgId } });
    if (!role) throw new NotFoundException({ title: 'Role not found', status: 404 });
    return role;
  }

  private async findOrgUser(orgId: string, userId: string) {
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, organizationId: orgId, accountType: 'STAFF' },
      select: { id: true, systemRole: true, customRoleId: true },
    });
    if (!user) throw new NotFoundException({ title: 'User not found', status: 404 });
    return user;
  }

  private async assertWorkspaceInOrg(orgId: string, workspaceId: string): Promise<void> {
    const ws = await this.prisma.client.workspace.findFirst({
      where: { id: workspaceId, organizationId: orgId },
      select: { id: true },
    });
    if (!ws) throw new NotFoundException({ title: 'Workspace not found', status: 404 });
  }

  private async memberCount(roleId: string): Promise<number> {
    const [u, m] = await Promise.all([
      this.prisma.client.user.count({ where: { customRoleId: roleId } }),
      this.prisma.client.workspaceMembership.count({ where: { customRoleId: roleId } }),
    ]);
    return u + m;
  }

  private forbidden(detail: string): ForbiddenException {
    return new ForbiddenException({ title: 'Forbidden', status: 403, detail });
  }

  private log(
    orgId: string,
    actor: RolesActor,
    action: string,
    target: string,
    metadata: Record<string, unknown>,
  ): void {
    void this.audit.emit({ organizationId: orgId, actorUserId: actor.userId, action, target, metadata });
  }
}
