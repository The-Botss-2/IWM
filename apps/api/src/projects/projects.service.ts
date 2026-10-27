import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateProjectInput,
  ListProjectsQuery,
  UpdateProjectInput,
} from '@botss/shared-types';

import type { AppAbility } from '@botss/auth';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { abilityRow } from '../common/permissions/request-ability';
import { projectAccessWhere } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /**
   * Where-clause that accepts either workspace OR project-membership access,
   * then applies the `Project.visibility` gate on top. See
   * ../common/project-access - the two halves live there so every service
   * that reads projects agrees on what "can read" means.
   */
  private accessFilter(scope: UserScope): Record<string, unknown> {
    return projectAccessWhere(scope);
  }

  async list(scope: UserScope, q: ListProjectsQuery) {
    // Collected as AND clauses rather than spread into one object: the access
    // filter now carries its own `AND` (reachability AND visibility), so the
    // old `where['AND'] = [...]` for search would have silently overwritten
    // the visibility half and leaked private projects into search results.
    const clauses: Record<string, unknown>[] = [this.accessFilter(scope)];
    if (q.search) {
      clauses.push({
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { key: { contains: q.search.toUpperCase() } },
        ],
      });
    }
    const where: Record<string, unknown> = { AND: clauses };
    if (q.status) where['status'] = q.status;
    if (q.clientId) where['clientId'] = q.clientId;

    const skip = (q.page - 1) * q.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.project.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: {
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          _count: { select: { memberships: true } },
        },
      }),
      this.prisma.client.project.count({ where }),
    ]);
    return {
      // Flatten Prisma's `_count` into the flat `memberCount` the DTO
      // declares, so the wire shape stays free of Prisma-isms.
      items: items.map(({ _count, ...p }) => ({
        ...p,
        memberCount: _count.memberships,
      })),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async get(scope: UserScope, id: string) {
    const project = await this.prisma.client.project.findFirst({
      where: { id, ...this.accessFilter(scope) },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        memberships: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
        },
      },
    });
    if (!project) throw new NotFoundException({ title: 'Project not found', status: 404 });
    return project;
  }

  /**
   * Project creation is workspace-scoped: the user must be a workspace member
   * of the target workspace. We accept the workspace id from AuthGuard (the
   * current workspace) since there's no body field for it yet.
   */
  /**
   * Derive a unique project key from the name when the user didn't supply one.
   * Key is uppercase, starts with a letter, 2-10 chars, and unique per
   * workspace. We check against the RAW client (not the soft-delete-filtered
   * one) because the `(workspaceId, key)` unique constraint still applies to
   * tombstoned rows - a generated key colliding with a soft-deleted project
   * would otherwise throw a confusing 409.
   */
  private async generateProjectKey(
    workspaceId: string,
    name: string,
  ): Promise<string> {
    // Uppercase alphanumerics only, must start with a letter. Cap the base at
    // 5 chars so there's room for a numeric suffix within the 10-char limit.
    const cleaned = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/^[0-9]+/, '');
    const base = cleaned.length >= 2 ? cleaned.slice(0, 5) : 'PRJ';

    const existing = await this.prisma.raw.project.findMany({
      where: { workspaceId, key: { startsWith: base } },
      select: { key: true },
    });
    const taken = new Set(existing.map((p) => p.key));
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, Math.max(2, 10 - suffix.length)) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
    // Pathological fallback (1000 projects sharing a prefix). Widen the suffix.
    return `${base.slice(0, 2)}${taken.size + 1}`;
  }

  /**
   * A project may only point at a client in its own workspace. The link
   * decides which client's portal people see the project, and invoices and
   * contracts already enforce the same rule.
   */
  private async assertClientInWorkspace(workspaceId: string, clientId: string): Promise<void> {
    const client = await this.prisma.client.client.findFirst({
      where: { id: clientId, workspaceId },
      select: { id: true },
    });
    if (!client) {
      throw new BadRequestException({
        title: 'Invalid client',
        status: 400,
        detail: 'The client must belong to the same workspace as the project.',
      });
    }
  }

  async create(workspaceId: string, userId: string, input: CreateProjectInput) {
    if (input.clientId) await this.assertClientInWorkspace(workspaceId, input.clientId);
    const key =
      input.key ?? (await this.generateProjectKey(workspaceId, input.name));
    return this.prisma.client.project.create({
      data: {
        workspaceId,
        createdById: userId,
        name: input.name,
        key,
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        memberships: { create: { userId, role: 'PROJECT_LEAD' } },
      },
    });
  }

  async update(scope: UserScope, id: string, input: UpdateProjectInput) {
    const current = await this.get(scope, id);
    if (input.clientId) await this.assertClientInWorkspace(current.workspaceId, input.clientId);
    // Linking a project to a (different) client puts it in that client's
    // portal. Deciding what a client sees belongs to workspace owners and
    // admins, org admins and the project lead (see ProjectPortalService), so
    // anyone else can still link it, but it arrives hidden from the portal
    // until one of them switches it on.
    let hideFromPortal = false;
    if (input.clientId && input.clientId !== current.clientId) {
      const [isAdmin, lead] = await Promise.all([
        this.workspaces.canAdminister(current.workspaceId, scope.userId),
        this.prisma.client.projectMembership.findFirst({
          where: { projectId: id, userId: scope.userId, role: 'PROJECT_LEAD' },
          select: { id: true },
        }),
      ]);
      hideFromPortal = !isAdmin && !lead;
    }
    // Whitelist explicitly. Spreading `input` would leak any future widening
    // of `updateProjectSchema` straight into Prisma - e.g. accidentally
    // adding `workspaceId` would let a member rehome the project to another
    // workspace.
    return this.prisma.client.project.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.key !== undefined ? { key: input.key } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
        ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
        ...(hideFromPortal ? { portalVisible: false } : {}),
        ...(input.workflowSettings !== undefined ? { workflowSettings: input.workflowSettings } : {}),
      },
    });
  }

  async remove(scope: UserScope, ability: AppAbility, id: string) {
    const project = await this.get(scope, id);
    // Deletion is only allowed for users who have workspace-level access - an
    // outside project member shouldn't be able to delete the parent project.
    if (!scope.workspaceIds.includes(project.workspaceId)) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Deleting a project requires workspace membership.',
      });
    }
    // Row-level: `projects.delete`, or PROJECT_LEAD of THIS project (`manage
    // Project { id }`). PermissionsGuard only saw the bare subject, so a lead
    // of any one project used to pass it for every project.
    if (!ability.can('delete', abilityRow('Project', { id: project.id }))) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only a lead of this project, or someone allowed to delete projects, can delete it.',
        code: 'insufficient_permissions',
      });
    }
    await this.prisma.client.project.delete({ where: { id } });
  }

  async archive(scope: UserScope, id: string) {
    await this.get(scope, id);
    return this.prisma.client.project.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
  }

  async restore(scope: UserScope, id: string) {
    await this.get(scope, id);
    return this.prisma.client.project.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
  }

  /**
   * Dashboard payload for the Summary tab. Single query per chart kept in a
   * Promise.all so the route serves in one round-trip.
   */
  async summary(scope: UserScope, id: string) {
    const project = await this.get(scope, id);
    const now = new Date();

    const [
      byStatus,
      byPriority,
      byAssigneeRows,
      overdue,
      upcoming,
      activeSprint,
      recentTasks,
      recentSprints,
      recentGoalUpdates,
    ] = await Promise.all([
      this.prisma.client.task.groupBy({
        by: ['status'],
        where: { projectId: id },
        _count: { _all: true },
      }),
      this.prisma.client.task.groupBy({
        by: ['priority'],
        where: { projectId: id },
        _count: { _all: true },
      }),
      this.prisma.client.task.groupBy({
        by: ['assigneeId'],
        where: { projectId: id },
        _count: { _all: true },
      }),
      this.prisma.client.task.count({
        where: {
          projectId: id,
          dueDate: { lt: now },
          status: { notIn: ['DONE', 'CANCELLED'] },
        },
      }),
      this.prisma.client.task.findFirst({
        where: {
          projectId: id,
          dueDate: { gte: now },
          status: { notIn: ['DONE', 'CANCELLED'] },
        },
        orderBy: { dueDate: 'asc' },
        select: { id: true, title: true, dueDate: true },
      }),
      this.prisma.client.sprint.findFirst({
        where: { projectId: id, status: 'ACTIVE' },
        include: { tasks: { select: { id: true } } },
      }),
      this.prisma.client.task.findMany({
        where: { projectId: id },
        orderBy: { updatedAt: 'desc' },
        take: 10,
        select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, completedAt: true },
      }),
      this.prisma.client.sprint.findMany({
        where: { projectId: id, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        take: 3,
        select: { id: true, name: true, updatedAt: true },
      }),
      this.prisma.client.goalUpdate.findMany({
        where: { goal: { projectId: id } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, body: true, createdAt: true, goal: { select: { title: true } } },
      }),
    ]);

    // total / done / inProgress use exactly the byStatus filter (same where,
    // same soft-delete injection, subtasks included), so derive them from it
    // instead of issuing three more COUNT queries.
    let total = 0;
    let done = 0;
    let inProgress = 0;
    for (const r of byStatus) {
      total += r._count._all;
      if (r.status === 'DONE') done = r._count._all;
      else if (r.status === 'IN_PROGRESS') inProgress = r._count._all;
    }

    // Resolve assignee names for the byAssignee buckets.
    const assigneeIds = byAssigneeRows
      .map((r) => r.assigneeId)
      .filter((x): x is string => x !== null);
    const users =
      assigneeIds.length > 0
        ? await this.prisma.client.user.findMany({
            where: { id: { in: assigneeIds } },
            select: { id: true, name: true, email: true, image: true },
          })
        : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    void project;
    return {
      totals: { tasks: total, done, inProgress, overdue },
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      byPriority: byPriority.map((r) => ({ priority: r.priority, count: r._count._all })),
      byAssignee: byAssigneeRows.map((r) => ({
        user: r.assigneeId ? (userById.get(r.assigneeId) ?? null) : null,
        count: r._count._all,
      })),
      upcomingDeadline: upcoming
        ? { taskId: upcoming.id, title: upcoming.title, dueDate: upcoming.dueDate as Date }
        : null,
      activeSprint: activeSprint
        ? {
            id: activeSprint.id,
            name: activeSprint.name,
            endDate: activeSprint.endDate,
            taskCount: activeSprint.tasks.length,
          }
        : null,
      recentActivity: [
        ...recentTasks.map((t) => ({
          id: `task-${t.id}`,
          kind:
            t.status === 'DONE'
              ? ('task_completed' as const)
              : ('task_created' as const),
          title: t.title,
          at: (t.status === 'DONE' && t.completedAt ? t.completedAt : t.updatedAt) as Date,
        })),
        ...recentSprints.map((s) => ({
          id: `sprint-${s.id}`,
          kind: 'sprint_started' as const,
          title: `Sprint started: ${s.name}`,
          at: s.updatedAt,
        })),
        ...recentGoalUpdates.map((u) => ({
          id: `goalupd-${u.id}`,
          kind: 'goal_updated' as const,
          title: `Goal update: ${u.goal.title}`,
          at: u.createdAt,
        })),
      ]
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 20),
    };
  }

  async listArchivedTasks(scope: UserScope, id: string) {
    await this.get(scope, id);
    // Include soft-deleted rows AND CANCELLED status.
    // The soft-delete extension filter is bypassed with { includeDeleted: true }.
    const items = await (this.prisma.client.task.findMany as unknown as (
      args: unknown,
    ) => Promise<unknown>)({
      where: {
        projectId: id,
        OR: [{ deletedAt: { not: null } }, { status: 'CANCELLED' }],
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        assignee: { select: { id: true, name: true, email: true, image: true } },
      },
      includeDeleted: true,
    });
    const total = Array.isArray(items) ? items.length : 0;
    return {
      items,
      pagination: { page: 1, pageSize: total, total, totalPages: 1 },
    };
  }
}
