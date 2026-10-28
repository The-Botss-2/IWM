import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateGoalInput,
  CreateGoalUpdateInput,
  CreateKeyResultInput,
  GoalWithDetails,
  UpdateGoalInput,
  UpdateKeyResultInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { invalidReference, requireTenantRef } from '../common/tenant-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GoalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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
   * Scope check for workspace-level goals/KRs that have no project. Without
   * this, a null `projectId` skipped all access control and let any signed-in
   * user touch another tenant's goal by guessing its cuid.
   */
  private assertWorkspaceAccess(scope: UserScope, workspaceId: string): void {
    if (!scope.workspaceIds.includes(workspaceId)) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that goal.',
      });
    }
  }

  async list(scope: UserScope, projectId: string): Promise<GoalWithDetails[]> {
    await this.requireProject(scope, projectId);
    const goals = await this.prisma.client.goal.findMany({
      where: { projectId },
      orderBy: [{ status: 'asc' }, { endDate: 'asc' }],
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        keyResults: { orderBy: { position: 'asc' } },
      },
    });
    return goals.map((g) => ({
      id: g.id,
      workspaceId: g.workspaceId,
      projectId: g.projectId,
      parentGoalId: g.parentGoalId,
      title: g.title,
      description: g.description,
      ownerId: g.ownerId,
      startDate: g.startDate,
      endDate: g.endDate,
      status: g.status,
      createdAt: g.createdAt,
      updatedAt: g.updatedAt,
      owner: g.owner,
      keyResults: g.keyResults.map((k) => ({
        ...k,
        targetValue: k.targetValue.toString(),
        currentValue: k.currentValue.toString(),
      })),
      progress: computeProgress(g.keyResults),
    }));
  }

  async create(scope: UserScope, projectId: string, input: CreateGoalInput) {
    const project = await this.requireProject(scope, projectId);
    await this.assertOwnerInOrg(project.workspaceId, input.ownerId);
    if (input.parentGoalId) await this.assertParentGoal(project.workspaceId, input.parentGoalId);
    const created = await this.prisma.client.goal.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        title: input.title,
        description: input.description ?? null,
        ownerId: input.ownerId,
        startDate: input.startDate,
        endDate: input.endDate,
        parentGoalId: input.parentGoalId ?? null,
      },
    });
    if (input.ownerId && input.ownerId !== scope.userId) {
      void this.notifications
        .emit({
          userId: input.ownerId,
          actorId: scope.userId,
          type: 'GOAL_ASSIGNED',
          title: 'A goal was assigned to you',
          body: created.title,
          entityType: 'goal',
          entityId: created.id,
          url: `/projects/${projectId}`,
        })
        .catch(() => {});
    }
    return created;
  }

  async update(scope: UserScope, goalId: string, input: UpdateGoalInput) {
    const goal = await this.requireGoal(scope, goalId);
    if (input.ownerId) await this.assertOwnerInOrg(goal.workspaceId, input.ownerId);
    if (input.parentGoalId) {
      if (input.parentGoalId === goal.id) {
        throw invalidReference('parent goal', 'invalid_parent_goal');
      }
      await this.assertParentGoal(goal.workspaceId, input.parentGoalId);
    }
    return this.prisma.client.goal.update({ where: { id: goal.id }, data: input });
  }

  /** A parent goal must be in the same workspace (no cross-tenant links). */
  private async assertParentGoal(workspaceId: string, parentGoalId: string): Promise<void> {
    requireTenantRef(
      await this.prisma.client.goal.findFirst({
        where: { id: parentGoalId, workspaceId },
        select: { id: true },
      }),
      'parent goal',
      'invalid_parent_goal',
    );
  }

  async remove(scope: UserScope, goalId: string): Promise<void> {
    await this.requireGoal(scope, goalId);
    await this.prisma.client.goal.delete({ where: { id: goalId } });
  }

  async listKeyResults(scope: UserScope, goalId: string) {
    await this.requireGoal(scope, goalId);
    const rows = await this.prisma.client.keyResult.findMany({
      where: { goalId },
      orderBy: { position: 'asc' },
    });
    return rows.map((k) => ({
      ...k,
      targetValue: k.targetValue.toString(),
      currentValue: k.currentValue.toString(),
    }));
  }

  async createKeyResult(scope: UserScope, goalId: string, input: CreateKeyResultInput) {
    await this.requireGoal(scope, goalId);
    const last = await this.prisma.client.keyResult.findFirst({
      where: { goalId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const kr = await this.prisma.client.keyResult.create({
      data: {
        goalId,
        title: input.title,
        metricType: input.metricType,
        targetValue: new Prisma.Decimal(input.targetValue.toString()),
        currentValue: new Prisma.Decimal((input.currentValue ?? 0).toString()),
        unit: input.unit ?? null,
        position: (last?.position ?? -1) + 1,
      },
    });
    return {
      ...kr,
      targetValue: kr.targetValue.toString(),
      currentValue: kr.currentValue.toString(),
    };
  }

  async updateKeyResult(scope: UserScope, krId: string, input: UpdateKeyResultInput) {
    const kr = await this.prisma.client.keyResult.findUnique({
      where: { id: krId },
      include: { goal: { select: { projectId: true, workspaceId: true } } },
    });
    if (!kr) throw new NotFoundException({ title: 'Key result not found', status: 404 });
    if (kr.goal.projectId) {
      await this.requireProject(scope, kr.goal.projectId);
    } else {
      this.assertWorkspaceAccess(scope, kr.goal.workspaceId);
    }
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.metricType !== undefined) data['metricType'] = input.metricType;
    if (input.targetValue !== undefined)
      data['targetValue'] = new Prisma.Decimal(input.targetValue.toString());
    if (input.currentValue !== undefined)
      data['currentValue'] = new Prisma.Decimal(input.currentValue.toString());
    if (input.unit !== undefined) data['unit'] = input.unit;
    const updated = await this.prisma.client.keyResult.update({
      where: { id: krId },
      data,
    });
    return {
      ...updated,
      targetValue: updated.targetValue.toString(),
      currentValue: updated.currentValue.toString(),
    };
  }

  async removeKeyResult(scope: UserScope, krId: string): Promise<void> {
    const kr = await this.prisma.client.keyResult.findUnique({
      where: { id: krId },
      include: { goal: { select: { projectId: true, workspaceId: true } } },
    });
    if (!kr) throw new NotFoundException({ title: 'Key result not found', status: 404 });
    if (kr.goal.projectId) {
      await this.requireProject(scope, kr.goal.projectId);
    } else {
      this.assertWorkspaceAccess(scope, kr.goal.workspaceId);
    }
    await this.prisma.client.keyResult.delete({ where: { id: krId } });
  }

  async listUpdates(scope: UserScope, goalId: string) {
    await this.requireGoal(scope, goalId);
    const rows = await this.prisma.client.goalUpdate.findMany({
      where: { goalId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((u) => ({
      ...u,
      valueAt: u.valueAt?.toString() ?? null,
    }));
  }

  async createUpdate(
    scope: UserScope,
    userId: string,
    goalId: string,
    input: CreateGoalUpdateInput,
  ) {
    await this.requireGoal(scope, goalId);

    // The keyResultId arrives from the request body, so it must be proven to
    // belong to *this* goal before we write it or bump its currentValue.
    // Otherwise a caller with access to one goal could overwrite a KeyResult
    // in any other tenant's goal.
    if (input.keyResultId) {
      const kr = await this.prisma.client.keyResult.findFirst({
        where: { id: input.keyResultId, goalId },
        select: { id: true },
      });
      if (!kr) {
        throw new NotFoundException({
          title: 'Key result not found',
          status: 404,
          detail: 'That key result does not belong to this goal.',
        });
      }
    }

    const created = await this.prisma.client.goalUpdate.create({
      data: {
        goalId,
        authorId: userId,
        body: input.body,
        keyResultId: input.keyResultId ?? null,
        valueAt: input.valueAt !== undefined ? new Prisma.Decimal(input.valueAt.toString()) : null,
      },
    });

    // If the update carries a value AND targets a KR, bump KR.currentValue.
    if (input.keyResultId && input.valueAt !== undefined) {
      await this.prisma.client.keyResult.update({
        where: { id: input.keyResultId },
        data: { currentValue: new Prisma.Decimal(input.valueAt.toString()) },
      });
    }

    return { ...created, valueAt: created.valueAt?.toString() ?? null };
  }

  /**
   * A goal owner must be a team member in the goal's org - the same rule as
   * task assignees. Without it any user id could be written (and notified
   * with GOAL_ASSIGNED): another tenant's user, or a client-portal account.
   */
  private async assertOwnerInOrg(workspaceId: string, ownerId: string): Promise<void> {
    const [ws, owner] = await Promise.all([
      this.prisma.client.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      }),
      this.prisma.client.user.findUnique({
        where: { id: ownerId },
        select: { organizationId: true, accountType: true },
      }),
    ]);
    if (
      !ws ||
      !owner ||
      owner.accountType !== 'STAFF' ||
      owner.organizationId !== ws.organizationId
    ) {
      throw new BadRequestException({
        title: 'Invalid goal owner',
        status: 400,
        detail: 'The owner must be a team member in the same organization.',
      });
    }
  }

  private async requireGoal(scope: UserScope, goalId: string) {
    const goal = await this.prisma.client.goal.findUnique({
      where: { id: goalId },
      select: { id: true, projectId: true, workspaceId: true },
    });
    if (!goal) throw new NotFoundException({ title: 'Goal not found', status: 404 });
    if (goal.projectId) {
      await this.requireProject(scope, goal.projectId);
    } else {
      this.assertWorkspaceAccess(scope, goal.workspaceId);
    }
    return goal;
  }
}

function computeProgress(
  keyResults: { targetValue: Prisma.Decimal; currentValue: Prisma.Decimal }[],
): number {
  if (keyResults.length === 0) return 0;
  let total = 0;
  for (const kr of keyResults) {
    const t = Number(kr.targetValue);
    const c = Number(kr.currentValue);
    if (!t) continue;
    total += Math.min(1, Math.max(0, c / t));
  }
  return total / keyResults.length;
}
