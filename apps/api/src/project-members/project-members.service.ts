import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { scopeProjectAbilityRules } from '@botss/auth';
import type { Prisma } from '@botss/database';
import type {
  AddProjectMemberInput,
  ProjectAbilityRules,
  UpdateProjectMemberInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { loadEffectivePermissions } from '../common/permissions/effective-permissions';
import { projectAccessWhere } from '../common/project-access';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ProjectMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Confirms the user can SEE the project (workspace member OR project member).
   * Reading the member list is the lowest bar.
   */
  private async assertProjectVisible(scope: UserScope, projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...projectAccessWhere(scope) },
      select: { id: true },
    });
    if (!project) {
      throw new NotFoundException({ title: 'Project not found', status: 404 });
    }
  }

  /**
   * Membership mutation (add/update/remove) requires workspace-level access
   * to a project the caller can SEE, plus either the workspace permission
   * `members.manage` (or org-wide `workspaces.admin_all`) or the PROJECT_LEAD
   * role on THIS project. An outside collaborator (project-membership-only)
   * can read the team but not edit it.
   *
   * PermissionsGuard alone is not enough here: a lead of project A holds
   * `manage ProjectMembership { projectId: A }`, and the guard checks the bare
   * subject, so it also waves through requests for project B - including a
   * PRIVATE project B the lead could then join by adding themselves.
   *
   * Returns whether the caller holds `members.manage` (only those may set
   * per-member ability overrides).
   */
  private async assertProjectMutable(
    scope: UserScope,
    projectId: string,
  ): Promise<{ canManageMembers: boolean }> {
    if (scope.workspaceIds.length === 0) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Managing project members requires workspace membership.',
      });
    }
    const project = await this.prisma.client.project.findFirst({
      where: {
        AND: [
          { id: projectId, workspaceId: { in: scope.workspaceIds } },
          // Visibility too: a PRIVATE project you cannot see is not yours to staff.
          projectAccessWhere(scope),
        ],
      },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new NotFoundException({ title: 'Project not found', status: 404 });
    }
    const eff = await loadEffectivePermissions(scope.userId, project.workspaceId);
    const canManageMembers =
      eff.workspace.includes('members.manage') || eff.company.includes('workspaces.admin_all');
    if (canManageMembers) return { canManageMembers };
    const own = await this.prisma.client.projectMembership.findUnique({
      where: { projectId_userId: { projectId, userId: scope.userId } },
      select: { role: true },
    });
    if (own?.role !== 'PROJECT_LEAD') {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only a lead of this project or a workspace member manager can change its team.',
      });
    }
    return { canManageMembers: false };
  }

  /** Per-member overrides are a members.manage decision, never a lead's. */
  private assertMaySetAbilities(canManageMembers: boolean, abilities: unknown): void {
    if (abilities === undefined || canManageMembers) return;
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: 'Only workspace member managers can set per-member abilities.',
    });
  }

  async list(scope: UserScope, projectId: string) {
    await this.assertProjectVisible(scope, projectId);
    return this.prisma.client.projectMembership.findMany({
      where: { projectId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async add(scope: UserScope, projectId: string, input: AddProjectMemberInput) {
    const { canManageMembers } = await this.assertProjectMutable(scope, projectId);
    this.assertMaySetAbilities(canManageMembers, input.abilities);
    // Tenant boundary: the target user must live in the same org as the
    // project's workspace. Without this, a workspace OWNER could add a
    // foreign-org user to their project, granting them cross-tenant
    // visibility through the project membership path.
    const project = await this.prisma.client.project.findUnique({
      where: { id: projectId },
      select: { name: true, workspace: { select: { organizationId: true } } },
    });
    const targetUser = await this.prisma.client.user.findUnique({
      where: { id: input.userId },
      select: { organizationId: true },
    });
    if (!project || !targetUser) {
      throw new NotFoundException({
        title: 'Project or user not found',
        status: 404,
      });
    }
    if (targetUser.organizationId !== project.workspace.organizationId) {
      throw new ForbiddenException({
        title: "User is outside this project's organization",
        status: 403,
      });
    }
    const membership = await this.prisma.client.projectMembership.create({
      data: {
        projectId,
        userId: input.userId,
        role: input.role,
        ...(input.abilities ? { abilities: pinnedAbilities(input.abilities, projectId) } : {}),
      },
    });
    if (input.userId !== scope.userId) {
      void this.notifications
        .emit({
          userId: input.userId,
          actorId: scope.userId,
          type: 'PROJECT_ADDED',
          title: 'You were added to a project',
          body: project.name,
          entityType: 'project',
          entityId: projectId,
          url: `/projects/${projectId}`,
        })
        .catch(() => {});
    }
    return membership;
  }

  async update(
    scope: UserScope,
    projectId: string,
    membershipId: string,
    input: UpdateProjectMemberInput,
  ) {
    const { canManageMembers } = await this.assertProjectMutable(scope, projectId);
    this.assertMaySetAbilities(canManageMembers, input.abilities);
    // The membership id must belong to the project named in the URL. Without
    // this an attacker with access to *any* project they're allowed to edit
    // could mutate membership rows from other projects by passing the path
    // params for one project but the cuid for a row in another.
    await this.assertMembershipBelongsToProject(projectId, membershipId);
    const data: Prisma.ProjectMembershipUpdateInput = {};
    if (input.role !== undefined) data.role = input.role;
    if (input.abilities !== undefined) data.abilities = pinnedAbilities(input.abilities, projectId);
    return this.prisma.client.projectMembership.update({
      where: { id: membershipId },
      data,
    });
  }

  async remove(scope: UserScope, projectId: string, membershipId: string) {
    await this.assertProjectMutable(scope, projectId);
    await this.assertMembershipBelongsToProject(projectId, membershipId);
    await this.prisma.client.projectMembership.delete({ where: { id: membershipId } });
  }

  private async assertMembershipBelongsToProject(
    projectId: string,
    membershipId: string,
  ): Promise<void> {
    const row = await this.prisma.client.projectMembership.findUnique({
      where: { id: membershipId },
      select: { projectId: true },
    });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException({ title: 'Project member not found', status: 404 });
    }
  }
}

/**
 * Store overrides already in their enforced shape: allowlisted subjects and
 * actions only, every rule pinned to this project. The ability factory pins
 * again on read, so a row written before this existed is safe too.
 */
function pinnedAbilities(rules: ProjectAbilityRules, projectId: string): Prisma.InputJsonValue {
  return scopeProjectAbilityRules(rules, projectId).map((r) => ({
    action: r.action,
    subject: r.subject,
    conditions: r.conditions,
    ...(r.fields ? { fields: r.fields } : {}),
    ...(r.inverted ? { inverted: true } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}
