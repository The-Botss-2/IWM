import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateSavedViewInput,
  UpdateSavedViewInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Reachability + `Project.visibility`, both resolved by the shared helper.
   *  See ../common/project-access for why this isn't inlined per service. */
  private projectAccessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  private async requireProject(scope: UserScope, projectId: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...this.projectAccessFilter(scope) },
      select: { id: true, workspaceId: true },
    });
    if (!project) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that project.',
      });
    }
    return project;
  }

  /**
   * List the saved views relevant to a project: explicitly scoped to this
   * project OR shared workspace-level views the caller can see.
   */
  async list(scope: UserScope, projectId: string, userId: string) {
    const project = await this.requireProject(scope, projectId);
    return this.prisma.client.savedView.findMany({
      where: {
        OR: [
          // Project views: shared ones plus the caller's own private ones.
          // A private view belongs to its creator; listing every row with
          // this projectId exposed teammates' private views.
          { projectId, isShared: true },
          { projectId, createdById: userId },
          { workspaceId: project.workspaceId, projectId: null, isShared: true },
          { workspaceId: project.workspaceId, projectId: null, createdById: userId },
        ],
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(scope: UserScope, userId: string, projectId: string, input: CreateSavedViewInput) {
    const project = await this.requireProject(scope, projectId);
    const last = await this.prisma.client.savedView.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.client.savedView.create({
      data: {
        projectId,
        workspaceId: project.workspaceId,
        createdById: userId,
        name: input.name,
        icon: input.icon ?? null,
        scope: input.scope,
        isShared: input.isShared,
        config: input.config as unknown as object,
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  async update(scope: UserScope, id: string, input: UpdateSavedViewInput) {
    const view = await this.requireView(scope, id);
    const data: Record<string, unknown> = { ...input };
    if (input.config) data['config'] = input.config as unknown as object;
    return this.prisma.client.savedView.update({ where: { id: view.id }, data });
  }

  async remove(scope: UserScope, id: string): Promise<void> {
    await this.requireView(scope, id);
    await this.prisma.client.savedView.delete({ where: { id } });
  }

  private async requireView(scope: UserScope, id: string) {
    const view = await this.prisma.client.savedView.findUnique({ where: { id } });
    if (!view) throw new NotFoundException({ title: 'Saved view not found', status: 404 });
    if (view.projectId) {
      await this.requireProject(scope, view.projectId);
    } else {
      // Workspace-level view (no project): scope by workspace membership.
      // Without this a null projectId skipped all access control and let any
      // signed-in user edit/delete another tenant's shared view by cuid.
      if (!scope.workspaceIds.includes(view.workspaceId)) {
        throw new ForbiddenException({
          title: 'Forbidden',
          status: 403,
          detail: 'You do not have access to that saved view.',
        });
      }
    }
    // A private (non-shared) view can only be changed by the person who made
    // it. Shared views stay editable by anyone who can reach the project.
    if (!view.isShared && view.createdById !== scope.userId) {
      throw new NotFoundException({ title: 'Saved view not found', status: 404 });
    }
    return view;
  }
}
