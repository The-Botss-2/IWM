import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  projectPortalSettingsSchema,
  taskPortalVisibilitySchema,
  type ProjectPortalSettings,
  type TaskPortalVisibility,
  type UpdateProjectPortalInput,
  type UpdateTaskPortalVisibilityInput,
} from '@botss/shared-types';

import { AuditLogService } from '../audit-log/audit-log.service';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

/**
 * What a client sees of a project in the client portal: whether the project
 * shows at all, whether its task list shows every task or only marked ones,
 * and which tasks are marked.
 *
 * Deliberately NOT part of the generic project/task update: every workspace
 * MEMBER may edit tasks, but exposing work to a client is a decision for
 * workspace owners and admins, org admins, and the project's lead.
 */
@Injectable()
export class ProjectPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
    private readonly auditLog: AuditLogService,
  ) {}

  async updateProject(
    scope: UserScope,
    projectId: string,
    input: UpdateProjectPortalInput,
  ): Promise<ProjectPortalSettings> {
    const project = await this.manageableProject(scope, projectId);
    const updated = await this.prisma.client.project.update({
      where: { id: project.id },
      data: {
        ...(input.portalVisible !== undefined ? { portalVisible: input.portalVisible } : {}),
        ...(input.portalShowAllTasks !== undefined
          ? { portalShowAllTasks: input.portalShowAllTasks }
          : {}),
      },
      select: { id: true, portalVisible: true, portalShowAllTasks: true },
    });
    void this.auditLog.emit({
      organizationId: project.organizationId,
      actorUserId: scope.userId,
      action: 'project.portal_settings',
      target: `project:${project.id}`,
      metadata: { ...input },
    });
    return projectPortalSettingsSchema.parse(updated);
  }

  async updateTask(
    scope: UserScope,
    taskId: string,
    input: UpdateTaskPortalVisibilityInput,
  ): Promise<TaskPortalVisibility> {
    const task = await this.prisma.client.task.findFirst({
      where: { id: taskId, project: projectAccessWhere(scope) },
      select: { id: true, projectId: true },
    });
    if (!task) {
      throw new NotFoundException({ title: 'Task not found', status: 404 });
    }
    await this.manageableProject(scope, task.projectId);
    const updated = await this.prisma.client.task.update({
      where: { id: task.id },
      data: { portalVisible: input.portalVisible },
      select: { id: true, portalVisible: true },
    });
    return taskPortalVisibilitySchema.parse(updated);
  }

  private async manageableProject(
    scope: UserScope,
    projectId: string,
  ): Promise<{ id: string; workspaceId: string; organizationId: string }> {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...projectAccessWhere(scope) },
      select: { id: true, workspaceId: true, workspace: { select: { organizationId: true } } },
    });
    if (!project) {
      throw new NotFoundException({ title: 'Project not found', status: 404 });
    }
    const [isAdmin, lead] = await Promise.all([
      this.workspaces.canAdminister(project.workspaceId, scope.userId),
      this.prisma.client.projectMembership.findFirst({
        where: { projectId: project.id, userId: scope.userId, role: 'PROJECT_LEAD' },
        select: { id: true },
      }),
    ]);
    if (!isAdmin && !lead) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only workspace owners and admins or the project lead decide what a client sees.',
      });
    }
    return {
      id: project.id,
      workspaceId: project.workspaceId,
      organizationId: project.workspace.organizationId,
    };
  }
}
