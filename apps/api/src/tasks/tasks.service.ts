import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  BulkTaskRequest,
  CreateTaskInput,
  ListTasksQuery,
  ReorderTaskInput,
  UpdateTaskInput,
} from '@botss/shared-types';
import type { AppAbility } from '@botss/auth';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { densePositions, insertAt, rewritePositions } from '../common/positions';
import { abilityRow } from '../common/permissions/request-ability';
import { projectAccessWhere, projectVisibilityWhere } from '../common/project-access';
import { WorkspaceScopeService } from '../common/scope/workspace-scope.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MilestoneDeliveryService } from '../finance/milestone-delivery.service';
import { PrismaService } from '../prisma/prisma.service';

import { buildTaskListFilters } from './task-list-filters';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly milestoneDelivery: MilestoneDeliveryService,
    // Optional so legacy tests / sandboxes that don't import ScopeModule
    // still construct TasksService. When absent we fall back to the
    // pre-Phase-4 workspace-scoped behavior.
    @Optional() private readonly workspaceScope?: WorkspaceScopeService,
  ) {}

  /**
   * Reject an assignee that isn't in the same organization as the task's
   * project. Prevents assigning work to a user in another tenant (the task
   * doesn't leak to them, but it pollutes data and surfaces their identity).
   */
  private async assertAssigneeInOrg(projectId: string, assigneeId: string): Promise<void> {
    const [proj, assignee] = await Promise.all([
      this.prisma.client.project.findUnique({
        where: { id: projectId },
        select: { workspace: { select: { organizationId: true } } },
      }),
      this.prisma.client.user.findUnique({
        where: { id: assigneeId },
        select: { organizationId: true, accountType: true },
      }),
    ]);
    const orgId = proj?.workspace?.organizationId ?? null;
    if (
      !assignee ||
      assignee.accountType !== 'STAFF' ||
      (orgId && assignee.organizationId !== orgId)
    ) {
      throw new BadRequestException({
        title: 'Invalid assignee',
        status: 400,
        detail: 'The assignee must be a team member in the same organization.',
      });
    }
  }

  /** Where-fragment to constrain `task.project` to projects the user can read.
   *  Includes the `Project.visibility` gate - see ../common/project-access. */
  private projectAccessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  async list(scope: UserScope, q: ListTasksQuery) {
    // Phase 4 org-layer: if the caller asked for the aggregate view OR
    // explicitly named a workspace, ask the scope service to resolve a
    // wider set than the header-bound one. The resolver verifies that
    // any requested workspace belongs to the caller's org and refuses
    // (404) anything outside it, so this can't be used to read across
    // tenants.
    const orgScopedWorkspaceIds =
      this.workspaceScope && (q.aggregate === 'org' || q.workspaceId)
        ? await this.workspaceScope
            .resolve(scope.userId, q.workspaceId ?? null)
            .then((r) => r.workspaceIds)
        : null;

    // The org-aggregate path resolves its own workspace set and so skips
    // `projectAccessFilter`. It still has to honour PRIVATE projects, hence
    // the visibility clause composed in explicitly here.
    const visibility = projectVisibilityWhere(scope);
    const where: Record<string, unknown> = orgScopedWorkspaceIds
      ? {
          project: {
            workspaceId: { in: orgScopedWorkspaceIds },
            ...(visibility ?? {}),
          },
        }
      : { project: this.projectAccessFilter(scope) };
    // User-chosen filters, ANDed with the access scope above.
    const filters = buildTaskListFilters(q, scope.userId);
    if (filters.length > 0) where['AND'] = filters;

    const skip = (q.page - 1) * q.pageSize;
    const orderBy =
      q.sort === 'position'
        ? [{ status: 'asc' as const }, { position: 'asc' as const }]
        : { [q.sort]: q.order };
    const [items, total] = await Promise.all([
      this.prisma.client.task.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy,
        include: {
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          assignee: { select: { id: true, name: true, email: true, image: true } },
          sprintTasks: { include: { sprint: { select: { id: true, name: true } } } },
          project: {
            select: {
              id: true,
              name: true,
              key: true,
              color: true,
              workspace: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.client.task.count({ where }),
    ]);

    return {
      items,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async get(scope: UserScope, id: string) {
    const task = await this.prisma.client.task.findFirst({
      where: { id, project: this.projectAccessFilter(scope) },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        assignee: { select: { id: true, name: true, email: true, image: true } },
        sprintTasks: { include: { sprint: { select: { id: true, name: true } } } },
        subtasks: true,
      },
    });
    if (!task) throw new NotFoundException({ title: 'Task not found', status: 404 });
    return task;
  }

  async create(scope: UserScope, userId: string, input: CreateTaskInput) {
    const project = await this.prisma.client.project.findFirst({
      where: { id: input.projectId, ...this.projectAccessFilter(scope) },
      select: { id: true },
    });
    if (!project) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to that project.',
      });
    }

    if (input.parentTaskId) {
      const parent = await this.prisma.client.task.findFirst({
        where: {
          id: input.parentTaskId,
          projectId: input.projectId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!parent) {
        throw new NotFoundException({
          title: 'Parent task not found',
          status: 404,
          detail: 'The parent task must belong to the same project.',
        });
      }
    }

    if (input.assigneeId) {
      await this.assertAssigneeInOrg(input.projectId, input.assigneeId);
    }

    const status = input.status ?? 'BACKLOG';
    const last = await this.prisma.client.task.findFirst({
      where: { projectId: input.projectId, status },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const position = input.position ?? (last ? last.position + 1 : 0);

    const created = await this.prisma.client.task.create({
      data: {
        projectId: input.projectId,
        createdById: userId,
        title: input.title,
        status,
        priority: input.priority ?? 'MEDIUM',
        position,
        ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.estimateHours !== undefined ? { estimateHours: input.estimateHours } : {}),
      },
    });

    console.log(
      `[TasksService] create: success, id=${created.id}, title=${created.title}, projectId=${created.projectId}, status=${created.status}`,
    );

    // Notify the assignee (unless they assigned themselves).
    if (input.assigneeId && input.assigneeId !== userId) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: userId,
          type: 'TASK_ASSIGNED',
          title: 'New task assigned to you',
          body: created.title,
          taskId: created.id,
          entityType: 'task',
          entityId: created.id,
          url: `/projects/${created.projectId}`,
        })
        .catch(() => {});
    }
    return created;
  }

  async update(scope: UserScope, id: string, input: UpdateTaskInput) {
    const existing = await this.get(scope, id);
    if (input.parentTaskId !== undefined && input.parentTaskId !== null) {
      if (input.parentTaskId === id) {
        throw new NotFoundException({
          title: 'Invalid parent task',
          status: 404,
          detail: 'A task cannot be its own parent.',
        });
      }
      const parent = await this.prisma.client.task.findFirst({
        where: {
          id: input.parentTaskId,
          projectId: existing.projectId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!parent) {
        throw new NotFoundException({
          title: 'Parent task not found',
          status: 404,
          detail: 'The parent task must belong to the same project.',
        });
      }
    }
    if (input.assigneeId) {
      await this.assertAssigneeInOrg(existing.projectId, input.assigneeId);
    }
    const updated = await this.prisma.client.task.update({ where: { id }, data: input });

    // Notify on a genuine reassignment to someone other than the actor.
    if (
      input.assigneeId &&
      input.assigneeId !== existing.assigneeId &&
      input.assigneeId !== scope.userId
    ) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: scope.userId,
          type: 'TASK_ASSIGNED',
          title: 'Task assigned to you',
          body: updated.title,
          taskId: updated.id,
          entityType: 'task',
          entityId: updated.id,
          url: `/projects/${updated.projectId}`,
        })
        .catch(() => {});
    }

    // A finance milestone may bill an explicit set of tasks. Fire-and-forget:
    // Financials must never be able to fail a task edit.
    if (input.status && input.status !== existing.status) {
      void this.milestoneDelivery.syncDeliveryForTask(id).catch(() => {});
    }

    return updated;
  }

  /**
   * Drag-and-drop the task to a new status/position on the kanban board.
   *
   * The client sends `position` as a 0-based INDEX in the target column (which
   * is what dnd-kit reports from its sortable strategy). We re-number the
   * destination column inside a transaction so the persisted `position` values
   * stay dense and unique - without that, two cards can end up sharing a
   * position and the column ordering becomes unstable on the next read.
   */
  async reorder(scope: UserScope, id: string, input: ReorderTaskInput) {
    const existing = await this.get(scope, id);
    const targetStatus = input.status;
    const targetIndex = Math.max(0, input.position);

    // completedAt: only stamp on the BACKLOG/TODO/... → DONE transition.
    // Within-DONE reorders (or DONE → DONE no-ops) must preserve the existing
    // completion timestamp, otherwise drag-to-reorder rewrites history.
    let completedAt: Date | null | undefined;
    if (targetStatus === 'DONE' && existing.status !== 'DONE') {
      completedAt = new Date();
    } else if (targetStatus !== 'DONE' && existing.status === 'DONE') {
      completedAt = null;
    } else {
      completedAt = undefined; // leave unchanged
    }

    const result = await this.prisma.client.$transaction(async (tx) => {
      // Pull all sibling tasks in the destination column (excluding the moving
      // task) sorted by current position. Insert the moving task at the target
      // index, then write back contiguous 0..N positions.
      const siblings = await tx.task.findMany({
        where: {
          projectId: existing.projectId,
          status: targetStatus,
          id: { not: id },
          deletedAt: null,
        },
        orderBy: { position: 'asc' },
        select: { id: true },
      });

      const ordered = insertAt(
        siblings.map((s) => s.id),
        id,
        targetIndex,
      );

      // The moving task changes status (and maybe completedAt) as well.
      await tx.task.update({
        where: { id },
        data: {
          status: targetStatus,
          position: ordered.indexOf(id),
          ...(completedAt !== undefined ? { completedAt } : {}),
        },
      });
      // Renumber the rest of the column in ONE statement instead of one
      // UPDATE per card. `updatedAt` is stamped as the per-row updates did.
      await rewritePositions(
        tx,
        'Task',
        densePositions(ordered).filter((row) => row.id !== id),
        { touchUpdatedAt: true },
      );

      return tx.task.findUniqueOrThrow({ where: { id } });
    });

    // Notify the task's creator when someone else moves it to Done.
    if (
      completedAt instanceof Date &&
      existing.createdById &&
      existing.createdById !== scope.userId
    ) {
      void this.notifications
        .emit({
          userId: existing.createdById,
          actorId: scope.userId,
          type: 'TASK_COMPLETED',
          title: 'Task completed',
          body: existing.title,
          taskId: id,
          entityType: 'task',
          entityId: id,
          url: `/projects/${existing.projectId}`,
        })
        .catch(() => {});
    }

    if (targetStatus !== existing.status) {
      void this.milestoneDelivery.syncDeliveryForTask(id).catch(() => {});
    }

    return result;
  }

  async remove(scope: UserScope, ability: AppAbility, id: string) {
    const task = await this.get(scope, id);
    assertMayDeleteTask(ability, task);
    await this.prisma.client.task.delete({ where: { id } });
  }

  /**
   * Bulk operation for the Board/List multi-select toolbar. We pre-filter the
   * requested ids by access (so a malicious caller can't mass-mutate tasks they
   * can't read) and execute the entire batch in a single transaction. On a
   * status transition into/out of DONE we stamp/clear completedAt to match the
   * single-task reorder semantics.
   */
  async bulk(
    scope: UserScope,
    ability: AppAbility,
    req: BulkTaskRequest,
  ): Promise<{ updated: number }> {
    if (req.ids.length === 0) return { updated: 0 };
    const op = req.operation;
    const accessible = (
      await this.prisma.client.task.findMany({
        where: { id: { in: req.ids }, project: this.projectAccessFilter(scope) },
        select: { id: true, status: true, projectId: true, createdById: true },
      })
    ).filter(
      // The route only proves `update Task`; a bulk delete must hold `delete`
      // on every row it touches (own tasks, tasks.delete_any, or project lead).
      (t) => op.kind !== 'delete' || ability.can('delete', abilityRow('Task', t)),
    );
    if (accessible.length === 0) return { updated: 0 };
    const ids = accessible.map((t) => t.id);

    // Same rule as single create/update: the assignee must be a team member
    // in the task's org. Bulk used to skip it, which let any user id -
    // another tenant's, or a client-portal account - be written.
    if (op.kind === 'assignee' && op.assigneeId) {
      for (const projectId of new Set(accessible.map((t) => t.projectId))) {
        await this.assertAssigneeInOrg(projectId, op.assigneeId);
      }
    }
    return this.prisma.client.$transaction(async (tx) => {
      if (op.kind === 'delete') {
        // Soft-delete via the extension's delete interceptor.
        const result = await tx.task.deleteMany({ where: { id: { in: ids } } });
        return { updated: result.count };
      }
      if (op.kind === 'assignee') {
        const result = await tx.task.updateMany({
          where: { id: { in: ids } },
          data: { assigneeId: op.assigneeId },
        });
        return { updated: result.count };
      }
      if (op.kind === 'priority') {
        const result = await tx.task.updateMany({
          where: { id: { in: ids } },
          data: { priority: op.priority },
        });
        return { updated: result.count };
      }
      // status transition - handle completedAt per-row since the rule depends
      // on the previous status.
      const now = new Date();
      const toDone = accessible.filter((t) => t.status !== 'DONE' && op.status === 'DONE');
      const fromDone = accessible.filter((t) => t.status === 'DONE' && op.status !== 'DONE');
      const sameSide = accessible.filter((t) => (t.status === 'DONE') === (op.status === 'DONE'));
      if (toDone.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: toDone.map((t) => t.id) } },
          data: { status: op.status, completedAt: now },
        });
      }
      if (fromDone.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: fromDone.map((t) => t.id) } },
          data: { status: op.status, completedAt: null },
        });
      }
      if (sameSide.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: sameSide.map((t) => t.id) } },
          data: { status: op.status },
        });
      }
      return { updated: ids.length };
    });
  }

  /** Soft-archive a task (sets deletedAt). Surfaced in the Archive view. */
  async archive(scope: UserScope, ability: AppAbility, id: string) {
    // Archiving is a soft delete and is gated like one.
    const task = await this.get(scope, id);
    assertMayDeleteTask(ability, task);
    // soft-delete extension converts .delete to a deletedAt update; we want
    // the row to come back via update too.
    await this.prisma.client.task.delete({ where: { id } });
    // Read back with includeDeleted so the caller sees the just-archived row.
    return (this.prisma.client.task.findUnique as unknown as (args: unknown) => Promise<unknown>)({
      where: { id },
      includeDeleted: true,
    });
  }

  /** Restore an archived task (clears deletedAt and bounces CANCELLED → BACKLOG). */
  async restore(scope: UserScope, id: string) {
    // Read the soft-deleted row, but constrain to the caller's scope so a
    // task in another workspace/org can't be resurrected by guessing its id.
    // findFirst + includeDeleted bypasses the soft-delete read filter while
    // still applying the project access constraint (mirrors get()).
    const existing = await (
      this.prisma.client.task.findFirst as unknown as (
        args: unknown,
      ) => Promise<{ id: string; status: 'BACKLOG' | 'CANCELLED' | string } | null>
    )({
      where: { id, project: this.projectAccessFilter(scope) },
      includeDeleted: true,
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Task not found', status: 404 });
    }
    return this.prisma.client.task.update({
      where: { id },
      data: {
        deletedAt: null,
        ...(existing.status === 'CANCELLED' ? { status: 'BACKLOG' as const } : {}),
      },
    });
  }
}

/**
 * Row-level delete: the creator (tasks.create grants `delete Task
 * { createdById: me }`), `tasks.delete_any`, or a lead of the task's project.
 * PermissionsGuard only saw the bare subject, which every task creator holds.
 */
export function assertMayDeleteTask(
  ability: AppAbility,
  task: { id: string; projectId: string; createdById: string },
): void {
  if (ability.can('delete', abilityRow('Task', task))) return;
  throw new ForbiddenException({
    title: 'Forbidden',
    status: 403,
    detail:
      'Only the person who created this task, a project lead, or someone allowed to delete any task can delete it.',
    code: 'insufficient_permissions',
  });
}
