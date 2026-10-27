import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type {
  CreateTodoInput,
  ListTodosQuery,
  Todo,
  TodoWithRefs,
  UpdateTodoInput,
} from '@botss/shared-types';

import { WorkspaceScopeService } from '../common/scope/workspace-scope.service';
import { orgWorkspaceMembership } from '../common/tenant-scope';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

type TodoRowWithRefs = {
  id: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  assigneeId: string | null;
  title: string;
  notes: string | null;
  dueDate: Date | null;
  priority: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  done: boolean;
  doneAt: Date | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  workspace?: { id: string; name: string } | null;
  project?: { id: string; name: string; color: string | null } | null;
  user?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
  assignee?: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  } | null;
};

@Injectable()
export class TodosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly workspaceScope?: WorkspaceScopeService,
  ) {}

  private mapRow(row: TodoRowWithRefs): TodoWithRefs {
    return {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      assigneeId: row.assigneeId,
      title: row.title,
      notes: row.notes,
      dueDate: row.dueDate,
      priority: row.priority,
      done: row.done,
      doneAt: row.doneAt,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      workspace: row.workspace ?? null,
      project: row.project ?? null,
      creator: row.user ?? null,
      assignee: row.assignee ?? null,
    };
  }

  /**
   * Visible todos = (created by me) ∪ (assigned to me). Org-wide when
   * `aggregate=org` is requested, otherwise constrained to the active
   * workspace. A specific `workspaceId` / `projectId` further narrows.
   */
  async list(
    userId: string,
    workspaceId: string,
    query: ListTodosQuery,
  ): Promise<{ items: TodoWithRefs[] }> {
    let workspaceIds: string[] | null = null;
    if (this.workspaceScope && (query.aggregate === 'org' || query.workspaceId)) {
      const scope = await this.workspaceScope.resolve(
        userId,
        query.workspaceId ?? null,
      );
      workspaceIds = scope.workspaceIds;
    }

    const where: Record<string, unknown> = {
      deletedAt: null,
      // OR: visible if I created OR I'm the assignee.
      OR: [{ userId }, { assigneeId: userId }],
    };
    if (workspaceIds) {
      where.workspaceId = { in: workspaceIds };
    } else {
      where.workspaceId = workspaceId;
    }
    if (query.projectId) where.projectId = query.projectId;
    if (query.done !== undefined) where.done = query.done;
    if (query.dueDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (query.dueDate === 'today') {
        where.dueDate = { gte: today, lt: tomorrow };
      } else if (query.dueDate === 'overdue') {
        where.dueDate = { lt: today };
      } else if (query.dueDate === 'upcoming') {
        where.dueDate = { gte: tomorrow };
      } else if (query.dueDate === 'today_and_no_date') {
        // Combine with the visibility OR using AND.
        const visibility = where.OR as Array<Record<string, unknown>>;
        delete where.OR;
        where.AND = [
          { OR: visibility },
          { OR: [{ dueDate: null }, { dueDate: { lt: tomorrow } }] },
        ];
      }
    }

    const rows = await this.prisma.client.todo.findMany({
      where,
      orderBy: [{ done: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      take: query.limit ?? 200,
      include: {
        workspace: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, color: true } },
        user: { select: { id: true, name: true, email: true, image: true } },
        assignee: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });
    return { items: rows.map((r) => this.mapRow(r as TodoRowWithRefs)) };
  }

  /**
   * Create a todo. Defaults to the active workspace + the creator as
   * the implicit assignee. Optional `workspaceId` lets a user create a
   * todo in any workspace they belong to in their org; optional
   * `projectId` ties it to a specific project; optional `assigneeId`
   * delegates it (the assignee must also be a member of the target
   * workspace).
   */
  async create(
    userId: string,
    workspaceId: string,
    input: CreateTodoInput,
  ): Promise<TodoWithRefs> {
    const targetWorkspaceId = input.workspaceId ?? workspaceId;

    // Verify the caller can create in the target workspace.
    await this.assertWorkspaceAccess(userId, targetWorkspaceId);

    if (input.projectId) {
      const proj = await this.prisma.client.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: targetWorkspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!proj) {
        throw new BadRequestException({
          title: 'Project not in target workspace',
          status: 400,
        });
      }
    }

    if (input.assigneeId && input.assigneeId !== userId) {
      const membership = await orgWorkspaceMembership(
        this.prisma,
        input.assigneeId,
        targetWorkspaceId,
      );
      if (!membership) {
        throw new BadRequestException({
          title: 'Assignee is not a member of that workspace',
          status: 400,
        });
      }
    }

    // sortOrder is per-(workspace, assignee or creator) so personal
    // lists stay ordered the way the assignee dragged them.
    const sortAnchorUserId = input.assigneeId ?? userId;
    const max = await this.prisma.client.todo.aggregate({
      where: {
        workspaceId: targetWorkspaceId,
        deletedAt: null,
        OR: [{ userId: sortAnchorUserId }, { assigneeId: sortAnchorUserId }],
      },
      _max: { sortOrder: true },
    });
    const sortOrder = (max._max.sortOrder ?? 0) + 1;

    const row = await this.prisma.client.todo.create({
      data: {
        userId,
        workspaceId: targetWorkspaceId,
        projectId: input.projectId ?? null,
        assigneeId: input.assigneeId ?? null,
        title: input.title.trim(),
        notes: input.notes ?? null,
        dueDate: input.dueDate ?? null,
        priority: input.priority ?? 'NONE',
        sortOrder,
      },
      include: {
        workspace: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, color: true } },
        user: { select: { id: true, name: true, email: true, image: true } },
        assignee: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });
    // Notify the assignee (the `!== userId` self-assign guard above already
    // ran for validation, but re-check here so the notification only fires
    // when someone delegates to another person).
    if (input.assigneeId && input.assigneeId !== userId) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: userId,
          type: 'TODO_ASSIGNED',
          title: 'A to-do was assigned to you',
          body: row.title,
          entityType: 'todo',
          entityId: row.id,
          url: '/todos',
        })
        .catch(() => {});
    }
    return this.mapRow(row as TodoRowWithRefs);
  }

  async update(
    userId: string,
    todoId: string,
    input: UpdateTodoInput,
  ): Promise<TodoWithRefs> {
    const existing = await this.prisma.client.todo.findFirst({
      where: { id: todoId, deletedAt: null },
      select: {
        id: true,
        userId: true,
        workspaceId: true,
        assigneeId: true,
        done: true,
      },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Todo not found', status: 404 });
    }
    // Either the creator or the current assignee may edit.
    if (existing.userId !== userId && existing.assigneeId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }

    if (input.projectId !== undefined && input.projectId !== null) {
      const proj = await this.prisma.client.project.findFirst({
        where: {
          id: input.projectId,
          workspaceId: existing.workspaceId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!proj) {
        throw new BadRequestException({
          title: 'Project not in the todo\'s workspace',
          status: 400,
        });
      }
    }

    if (input.assigneeId !== undefined && input.assigneeId !== null) {
      // Only the creator may re-delegate.
      if (existing.userId !== userId) {
        throw new ForbiddenException({
          title: 'Only the creator can change the assignee',
          status: 403,
        });
      }
      const membership = await orgWorkspaceMembership(
        this.prisma,
        input.assigneeId,
        existing.workspaceId,
      );
      if (!membership) {
        throw new BadRequestException({
          title: 'Assignee is not a member of that workspace',
          status: 400,
        });
      }
    }

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.dueDate !== undefined) data.dueDate = input.dueDate;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;
    if (input.projectId !== undefined) data.projectId = input.projectId;
    if (input.assigneeId !== undefined) data.assigneeId = input.assigneeId;
    if (input.done !== undefined) {
      data.done = input.done;
      data.doneAt = input.done ? new Date() : null;
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException({
        title: 'Nothing to update',
        status: 400,
      });
    }
    const row = await this.prisma.client.todo.update({
      where: { id: todoId },
      data,
      include: {
        workspace: { select: { id: true, name: true } },
        project: { select: { id: true, name: true, color: true } },
        user: { select: { id: true, name: true, email: true, image: true } },
        assignee: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });
    // Notify on a genuine re-delegation to someone other than the actor.
    if (
      input.assigneeId &&
      input.assigneeId !== existing.assigneeId &&
      input.assigneeId !== userId
    ) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: userId,
          type: 'TODO_ASSIGNED',
          title: 'A to-do was assigned to you',
          body: row.title,
          entityType: 'todo',
          entityId: row.id,
          url: '/todos',
        })
        .catch(() => {});
    }
    return this.mapRow(row as TodoRowWithRefs);
  }

  async remove(userId: string, todoId: string): Promise<{ ok: true }> {
    const existing = await this.prisma.client.todo.findFirst({
      where: { id: todoId, deletedAt: null },
      select: { id: true, userId: true, assigneeId: true },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Todo not found', status: 404 });
    }
    // Creator or assignee may dismiss it from their own list. For
    // simplicity we hard-delete in both cases; if you need per-user
    // hiding without affecting the other party, model that separately.
    if (existing.userId !== userId && existing.assigneeId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    await this.prisma.client.todo.update({
      where: { id: todoId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Confirm the caller is a member of the workspace they're writing into,
   * and that it is in their own organization (a leftover membership into
   * another org does not count).
   */
  private async assertWorkspaceAccess(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const membership = await orgWorkspaceMembership(this.prisma, userId, workspaceId);
    if (!membership) {
      throw new ForbiddenException({
        title: 'Not a member of that workspace',
        status: 403,
      });
    }
  }
}
