import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateSprintInput,
  type MoveSprintTaskInput,
  type ReorderSprintTaskInput,
  SPRINT_DATES_MESSAGE,
  type SprintWithStats,
  type UpdateSprintInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { densePositions, insertAt, rewritePositions } from '../common/positions';
import { projectAccessWhere } from '../common/project-access';
import { MilestoneDeliveryService } from '../finance/milestone-delivery.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SprintsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly milestoneDelivery: MilestoneDeliveryService,
  ) {}

  /** Reachability + `Project.visibility`, both resolved by the shared helper.
   *  See ../common/project-access for why this isn't inlined per service. */
  private projectAccessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  private async assertProjectAccess(scope: UserScope, projectId: string): Promise<void> {
    const project = await this.prisma.client.project.findFirst({
      where: { id: projectId, ...this.projectAccessFilter(scope) },
      select: { id: true },
    });
    if (!project) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that project.',
      });
    }
  }

  async list(scope: UserScope, projectId: string): Promise<SprintWithStats[]> {
    await this.assertProjectAccess(scope, projectId);
    const sprints = await this.prisma.client.sprint.findMany({
      where: { projectId },
      orderBy: [{ status: 'asc' }, { position: 'asc' }, { startDate: 'asc' }],
      include: {
        tasks: {
          orderBy: { position: 'asc' },
          include: { task: { select: { id: true, estimateHours: true } } },
        },
      },
    });
    return sprints.map((s) => ({
      id: s.id,
      projectId: s.projectId,
      name: s.name,
      goal: s.goal,
      startDate: s.startDate,
      endDate: s.endDate,
      status: s.status,
      position: s.position,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      taskCount: s.tasks.length,
      totalEstimateHours: s.tasks.reduce((sum, t) => sum + Number(t.task.estimateHours ?? 0), 0),
      taskIds: s.tasks.map((t) => t.task.id),
    }));
  }

  async create(scope: UserScope, projectId: string, input: CreateSprintInput) {
    await this.assertProjectAccess(scope, projectId);
    assertSprintDates(input.startDate, input.endDate);
    const last = await this.prisma.client.sprint.findFirst({
      where: { projectId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.prisma.client.sprint.create({
      data: {
        projectId,
        name: input.name,
        goal: input.goal ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  async update(scope: UserScope, sprintId: string, input: UpdateSprintInput) {
    const sprint = await this.requireSprint(scope, sprintId);
    // A partial edit may move one end only: check it against the stored other.
    assertSprintDates(input.startDate ?? sprint.startDate, input.endDate ?? sprint.endDate);
    return this.prisma.client.sprint.update({
      where: { id: sprint.id },
      data: input,
    });
  }

  async remove(scope: UserScope, sprintId: string): Promise<void> {
    await this.requireSprint(scope, sprintId);
    await this.prisma.client.sprint.delete({ where: { id: sprintId } });
  }

  /** Move PLANNED → ACTIVE and bump member tasks from BACKLOG → TODO. */
  async start(scope: UserScope, sprintId: string) {
    const sprint = await this.requireSprint(scope, sprintId);
    if (sprint.status !== 'PLANNED') {
      throw new BadRequestException({
        title: 'Already started',
        status: 400,
        detail: 'Only PLANNED sprints can be started.',
      });
    }
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.sprint.update({
        where: { id: sprintId },
        data: { status: 'ACTIVE' },
      });
      const memberTaskIds = (
        await tx.sprintTask.findMany({
          where: { sprintId },
          select: { taskId: true },
        })
      ).map((r) => r.taskId);
      if (memberTaskIds.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: memberTaskIds }, status: 'BACKLOG' },
          data: { status: 'TODO' },
        });
      }
      return updated;
    });
  }

  /** Move ACTIVE → COMPLETED and bounce incomplete tasks back to BACKLOG. */
  async complete(scope: UserScope, sprintId: string) {
    const sprint = await this.requireSprint(scope, sprintId);
    if (sprint.status !== 'ACTIVE') {
      throw new BadRequestException({
        title: 'Not active',
        status: 400,
        detail: 'Only ACTIVE sprints can be completed.',
      });
    }
    const result = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.sprint.update({
        where: { id: sprintId },
        data: { status: 'COMPLETED' },
      });
      const incomplete = await tx.sprintTask.findMany({
        where: {
          sprintId,
          task: { status: { notIn: ['DONE', 'CANCELLED'] } },
        },
        select: { id: true, taskId: true },
      });
      if (incomplete.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: incomplete.map((r) => r.taskId) } },
          data: { status: 'BACKLOG' },
        });
        await tx.sprintTask.deleteMany({
          where: { id: { in: incomplete.map((r) => r.id) } },
        });
      }
      return updated;
    });

    // A finance milestone may bill this sprint. Fire-and-forget AFTER the
    // commit: Financials must never be able to roll back a sprint close.
    void this.milestoneDelivery.syncDeliveryForSprint(sprintId).catch(() => {});

    return result;
  }

  async addTask(scope: UserScope, userId: string, sprintId: string, taskId: string) {
    const sprint = await this.requireSprint(scope, sprintId);
    const task = await this.prisma.client.task.findFirst({
      where: { id: taskId, projectId: sprint.projectId },
      select: { id: true },
    });
    if (!task) {
      throw new NotFoundException({ title: 'Task not found in this project', status: 404 });
    }
    const last = await this.prisma.client.sprintTask.findFirst({
      where: { sprintId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    await this.prisma.client.sprintTask.upsert({
      where: { sprintId_taskId: { sprintId, taskId } },
      update: {},
      create: {
        sprintId,
        taskId,
        addedById: userId,
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  async removeTask(scope: UserScope, sprintId: string, taskId: string) {
    await this.requireSprint(scope, sprintId);
    await this.prisma.client.sprintTask.deleteMany({
      where: { sprintId, taskId },
    });
  }

  /**
   * Reorder a task within a sprint. The client sends the 0-based target index
   * (what dnd-kit's sortable strategy reports); we re-number every member so
   * positions stay dense.
   */
  async reorderTask(
    scope: UserScope,
    sprintId: string,
    input: ReorderSprintTaskInput,
  ): Promise<void> {
    const sprint = await this.requireSprint(scope, sprintId);
    if (sprint.status === 'COMPLETED') {
      throw new BadRequestException({
        title: 'Sprint is completed',
        status: 400,
        detail: 'Cannot reorder tasks in a completed sprint.',
      });
    }
    await this.prisma.client.$transaction(async (tx) => {
      const members = await tx.sprintTask.findMany({
        where: { sprintId },
        orderBy: { position: 'asc' },
        select: { id: true, taskId: true },
      });
      const moving = members.find((m) => m.taskId === input.taskId);
      if (!moving) {
        throw new NotFoundException({
          title: 'Task not in this sprint',
          status: 404,
        });
      }
      const without = members.filter((m) => m.taskId !== input.taskId);
      const reordered = insertAt(without, moving, input.position);
      // One statement for the whole sprint instead of one UPDATE per row.
      await rewritePositions(tx, 'SprintTask', densePositions(reordered.map((r) => r.id)));
    });
  }

  /**
   * Move a SprintTask from one sprint to another. The source SprintTask is
   * deleted and a new one created in the target sprint (preserving addedById
   * via the original row). All positions in both sprints are renumbered so
   * gaps don't accumulate.
   */
  async moveTask(scope: UserScope, input: MoveSprintTaskInput): Promise<void> {
    if (input.fromSprintId === input.toSprintId) {
      if (input.position !== undefined) {
        await this.reorderTask(scope, input.fromSprintId, {
          taskId: input.taskId,
          position: input.position,
        });
      }
      return;
    }
    const fromSprint = await this.requireSprint(scope, input.fromSprintId);
    const toSprint = await this.requireSprint(scope, input.toSprintId);
    if (fromSprint.projectId !== toSprint.projectId) {
      throw new BadRequestException({
        title: 'Cross-project move',
        status: 400,
        detail: 'Cannot move a task between sprints in different projects.',
      });
    }
    if (toSprint.status === 'COMPLETED') {
      throw new BadRequestException({
        title: 'Sprint is completed',
        status: 400,
        detail: 'Cannot move tasks into a completed sprint.',
      });
    }
    await this.prisma.client.$transaction(async (tx) => {
      const source = await tx.sprintTask.findUnique({
        where: { sprintId_taskId: { sprintId: input.fromSprintId, taskId: input.taskId } },
        select: { addedById: true },
      });
      if (!source) {
        throw new NotFoundException({
          title: 'Task not in source sprint',
          status: 404,
        });
      }
      await tx.sprintTask.delete({
        where: { sprintId_taskId: { sprintId: input.fromSprintId, taskId: input.taskId } },
      });
      const targetMembers = await tx.sprintTask.findMany({
        where: { sprintId: input.toSprintId },
        orderBy: { position: 'asc' },
        select: { id: true, taskId: true },
      });
      const insertAt =
        input.position === undefined
          ? targetMembers.length
          : Math.min(Math.max(0, input.position), targetMembers.length);
      const created = await tx.sprintTask.create({
        data: {
          sprintId: input.toSprintId,
          taskId: input.taskId,
          addedById: source.addedById,
          position: insertAt,
        },
        select: { id: true, taskId: true },
      });
      const reordered = [
        ...targetMembers.slice(0, insertAt),
        created,
        ...targetMembers.slice(insertAt),
      ];
      // One statement for the whole sprint instead of one UPDATE per row.
      await rewritePositions(tx, 'SprintTask', densePositions(reordered.map((r) => r.id)));
    });
  }

  private async requireSprint(scope: UserScope, sprintId: string) {
    const sprint = await this.prisma.client.sprint.findUnique({
      where: { id: sprintId },
      include: { project: { select: { id: true, workspaceId: true } } },
    });
    if (!sprint) {
      throw new NotFoundException({ title: 'Sprint not found', status: 404 });
    }
    await this.assertProjectAccess(scope, sprint.projectId);
    return sprint;
  }
}

/** A sprint may be a single day; it may not end before it starts. */
function assertSprintDates(startDate: Date, endDate: Date): void {
  if (endDate.getTime() < startDate.getTime()) {
    throw new BadRequestException({
      title: 'Invalid dates',
      status: 400,
      detail: SPRINT_DATES_MESSAGE,
      code: 'invalid_sprint_dates',
    });
  }
}
