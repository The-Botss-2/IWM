import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  AdminAttendanceResponse,
  AdminTimesheetsListQuery,
  CreateTimeEntryInput,
  ListTimesheetsQuery,
  StartTimerInput,
  TimeEntryWithMeta,
  TimesheetSummaryResponse,
  UpdateTimeEntryInput,
} from '@botss/shared-types';

import { userOrgId } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';

const ENTRY_INCLUDE = {
  project: { select: { id: true, name: true, color: true } },
  task: { select: { id: true, title: true } },
  user: { select: { id: true, name: true, email: true, image: true } },
} satisfies Prisma.TimeEntryInclude;

@Injectable()
export class TimesheetsService {
  private readonly logger = new Logger(TimesheetsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Auto-mark a user PRESENT for the UTC-midnight day of `date`. Logging
   * a timesheet is proof of work, so the Attendance row should reflect
   * that in real time instead of waiting for the next-morning cron.
   *
   * Preserves LEAVE rows - an approved leave outranks an accidental
   * time entry, matching the cron's own precedence (LEAVE > PRESENT).
   * Failures are swallowed: a hiccup here must never block the
   * timesheet write itself.
   */
  private async autoMarkAttendance(
    userId: string,
    date: Date,
  ): Promise<void> {
    const day = new Date(date);
    day.setUTCHours(0, 0, 0, 0);
    try {
      const existing = await this.prisma.client.attendance.findUnique({
        where: { userId_date: { userId, date: day } },
        select: { status: true },
      });
      if (existing?.status === 'LEAVE') return;
      await this.prisma.client.attendance.upsert({
        where: { userId_date: { userId, date: day } },
        create: { userId, date: day, status: 'PRESENT' },
        update: { status: 'PRESENT' },
      });
    } catch (err) {
      this.logger.warn(
        `autoMarkAttendance failed userId=${userId} date=${day.toISOString().slice(0, 10)} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  private mapRow(
    row: Prisma.TimeEntryGetPayload<{ include: typeof ENTRY_INCLUDE }>,
  ): TimeEntryWithMeta {
    return {
      id: row.id,
      userId: row.userId,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      projectLabel: row.projectLabel,
      taskId: row.taskId,
      taskLabel: row.taskLabel,
      description: row.description,
      startTime: row.startTime,
      endTime: row.endTime,
      durationMin: row.durationMin,
      // Surface pause state so the UI can render Pause / Resume controls
      // without an extra round-trip. Pre-pause-fields rows return defaults
      // (null + 0) because of the column defaults at the DB layer.
      pausedAt: row.pausedAt,
      accumulatedPauseMin: row.accumulatedPauseMin,
      billable: row.billable,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      project: row.project,
      task: row.task,
      user: row.user,
    };
  }

  /**
   * Timesheets are workspace-independent. A `projectId` is valid for a user
   * as long as the project lives in *any* workspace they are a member of.
   * This intentionally ignores the request's current workspace cookie so
   * users can log time against a project from a different workspace without
   * having to switch tenants in the UI first.
   */
  private async assertProjectAccessibleToUser(
    userId: string,
    projectId: string,
  ): Promise<void> {
    const orgId = await userOrgId(this.prisma, userId);
    const project = orgId
      ? await this.prisma.client.project.findFirst({
          where: {
            id: projectId,
            deletedAt: null,
            workspace: {
              organizationId: orgId,
              memberships: { some: { userId } },
            },
          },
          select: { id: true },
        })
      : null;
    if (!project) {
      throw new BadRequestException({
        title: 'Project not accessible',
        status: 400,
        detail: 'You are not a member of the workspace that owns this project.',
      });
    }
  }

  /**
   * The task must live in a project inside a workspace the user belongs to,
   * whether or not a projectId was supplied. The lookup used to be by id
   * alone, and the entry response echoes `task.title`, so posting another
   * organization's task id leaked that task's title.
   */
  private async assertTaskInProject(
    userId: string,
    taskId: string,
    projectId: string | undefined,
  ): Promise<void> {
    const orgId = await userOrgId(this.prisma, userId);
    const task = orgId
      ? await this.prisma.client.task.findFirst({
          where: {
            id: taskId,
            deletedAt: null,
            project: {
              deletedAt: null,
              workspace: { organizationId: orgId, memberships: { some: { userId } } },
            },
          },
          select: { id: true, projectId: true },
        })
      : null;
    if (!task) {
      throw new BadRequestException({ title: 'Task not found', status: 400 });
    }
    if (projectId && task.projectId !== projectId) {
      throw new BadRequestException({
        title: 'Task does not belong to this project',
        status: 400,
      });
    }
  }

  /** The actor's organization; `'__none__'` (matches nobody) when org-less. */
  private async resolveActorOrg(userId: string): Promise<{ organizationId: string }> {
    const u = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    return { organizationId: u?.organizationId ?? '__none__' };
  }

  /**
   * Resolve whose timesheet an admin caller may read. Non-admins are pinned
   * to themselves; an ADMIN or SUPER_ADMIN may target users in their own
   * org only. Prevents an admin from reading another org's user by passing
   * their id.
   */
  private async resolveAdminTargetUser(
    actingUserId: string,
    requestedUserId: string | undefined,
  ): Promise<string> {
    if (!requestedUserId || requestedUserId === actingUserId) {
      return actingUserId;
    }
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organizationId: true },
    });
    const isAdmin =
      actor?.systemRole === 'ADMIN' || actor?.systemRole === 'SUPER_ADMIN';
    if (!isAdmin) return actingUserId;
    const target = await this.prisma.client.user.findUnique({
      where: { id: requestedUserId },
      select: { organizationId: true },
    });
    if (!target || !actor?.organizationId || target.organizationId !== actor.organizationId) {
      throw new ForbiddenException({
        title: 'User is outside your organization',
        status: 403,
      });
    }
    return requestedUserId;
  }

  async list(
    actingUserId: string,
    _workspaceId: string,
    query: ListTimesheetsQuery,
  ): Promise<{ items: TimeEntryWithMeta[] }> {
    const targetUserId = await this.resolveAdminTargetUser(
      actingUserId,
      query.userId,
    );
    // Timesheets are intentionally cross-workspace: a single user's tracked
    // time is a personal log, not tenant-scoped. We still keep workspaceId on
    // the row for traceability but don't filter by it on reads.
    const where: Prisma.TimeEntryWhereInput = {
      userId: targetUserId,
      deletedAt: null,
    };
    if (query.projectId) where.projectId = query.projectId;
    if (query.from || query.to) {
      where.startTime = {};
      if (query.from) (where.startTime as Prisma.DateTimeFilter).gte = query.from;
      if (query.to) (where.startTime as Prisma.DateTimeFilter).lte = query.to;
    }
    if (query.running !== undefined) {
      where.endTime = query.running ? null : { not: null };
    }
    const rows = await this.prisma.client.timeEntry.findMany({
      where,
      orderBy: { startTime: 'desc' },
      include: ENTRY_INCLUDE,
      take: 500,
    });
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  async startTimer(
    userId: string,
    workspaceId: string,
    input: StartTimerInput,
  ): Promise<TimeEntryWithMeta> {
    if (input.projectId) {
      await this.assertProjectAccessibleToUser(userId, input.projectId);
    }
    if (input.taskId) {
      await this.assertTaskInProject(userId, input.taskId, input.projectId);
    }
    const projectLabel = input.projectLabel?.trim();
    const taskLabel = input.taskLabel?.trim();

    // "Already running" is cross-workspace - one timer at a time per user,
    // regardless of which workspace they were on when they started it. The
    // check + create runs inside a transaction so two concurrent requests
    // can't both pass the check before either commits. Note: the database
    // does not yet have a partial-unique index on (userId) WHERE endTime IS
    // NULL, so the transaction is the only thing stopping a true parallel
    // race - adding that index is a separate follow-up.
    const row = await this.prisma.client.$transaction(async (tx) => {
      const running = await tx.timeEntry.findFirst({
        where: { userId, endTime: null, deletedAt: null },
        select: { id: true },
      });
      if (running) {
        throw new BadRequestException({
          title: 'A timer is already running. Stop it before starting a new one.',
          status: 400,
        });
      }
      return tx.timeEntry.create({
        data: {
          userId,
          workspaceId,
          projectId: input.projectId ?? null,
          projectLabel: input.projectId
            ? null
            : projectLabel && projectLabel.length > 0
              ? projectLabel
              : null,
          taskId: input.taskId ?? null,
          taskLabel: input.taskId
            ? null
            : taskLabel && taskLabel.length > 0
              ? taskLabel
              : null,
          description: input.description ?? null,
          startTime: new Date(),
          billable: input.billable ?? true,
        },
        include: ENTRY_INCLUDE,
      });
    });
    await this.autoMarkAttendance(userId, row.startTime);
    return this.mapRow(row);
  }

  async stopTimer(
    userId: string,
    entryId: string,
  ): Promise<TimeEntryWithMeta> {
    // Wrap stop in a transaction so the pause-fold + endTime + durationMin
    // update is atomic. Stopping a paused timer needs to first credit the
    // open pause delta to `accumulatedPauseMin`, then close out the row.
    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.timeEntry.findFirst({
        where: { id: entryId, deletedAt: null },
        select: {
          id: true,
          userId: true,
          startTime: true,
          endTime: true,
          pausedAt: true,
          accumulatedPauseMin: true,
        },
      });
      if (!existing) {
        throw new NotFoundException({ title: 'Time entry not found', status: 404 });
      }
      if (existing.userId !== userId) {
        throw new ForbiddenException({ title: 'Forbidden', status: 403 });
      }
      if (existing.endTime) {
        throw new BadRequestException({
          title: 'Timer is already stopped',
          status: 400,
        });
      }
      const endTime = new Date();
      // If stopped while paused, fold the open pause window into the
      // accumulator BEFORE computing durationMin so the user isn't billed
      // for the paused interval.
      let pauseTotal = existing.accumulatedPauseMin;
      if (existing.pausedAt) {
        const extra = Math.max(
          0,
          Math.round((endTime.getTime() - existing.pausedAt.getTime()) / 60_000),
        );
        pauseTotal += extra;
      }
      const grossMinutes = Math.max(
        0,
        Math.round((endTime.getTime() - existing.startTime.getTime()) / 60_000),
      );
      const durationMin = Math.max(0, grossMinutes - pauseTotal);
      const row = await tx.timeEntry.update({
        where: { id: entryId },
        data: {
          endTime,
          durationMin,
          pausedAt: null,
          accumulatedPauseMin: pauseTotal,
        },
        include: ENTRY_INCLUDE,
      });
      await this.autoMarkAttendance(row.userId, row.startTime);
      return this.mapRow(row);
    });
  }

  /**
   * Mark a running timer as paused. Idempotent against repeated calls?
   * No - pausing an already-paused timer is a state error (matches the
   * spec: `400 Bad Request`). The exists / running / not-paused checks
   * all run inside the transaction so a racing pause/resume pair from
   * two tabs can't both succeed.
   */
  async pauseTimer(
    userId: string,
    entryId: string,
  ): Promise<TimeEntryWithMeta> {
    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.timeEntry.findFirst({
        where: { id: entryId, deletedAt: null },
        select: { id: true, userId: true, endTime: true, pausedAt: true },
      });
      if (!existing) {
        throw new NotFoundException({ title: 'Time entry not found', status: 404 });
      }
      if (existing.userId !== userId) {
        throw new ForbiddenException({ title: 'Forbidden', status: 403 });
      }
      if (existing.endTime) {
        throw new BadRequestException({
          title: 'Cannot pause a stopped timer.',
          status: 400,
        });
      }
      if (existing.pausedAt) {
        throw new ConflictException({
          title: 'Timer is already paused.',
          status: 409,
        });
      }
      const row = await tx.timeEntry.update({
        where: { id: entryId },
        data: { pausedAt: new Date() },
        include: ENTRY_INCLUDE,
      });
      return this.mapRow(row);
    });
  }

  /**
   * Resume a paused timer. Folds the just-closed pause window into the
   * accumulator and clears `pausedAt`. Rejects with `400` if the timer
   * is running (nothing to resume) or stopped.
   */
  async resumeTimer(
    userId: string,
    entryId: string,
  ): Promise<TimeEntryWithMeta> {
    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.timeEntry.findFirst({
        where: { id: entryId, deletedAt: null },
        select: {
          id: true,
          userId: true,
          endTime: true,
          pausedAt: true,
          accumulatedPauseMin: true,
        },
      });
      if (!existing) {
        throw new NotFoundException({ title: 'Time entry not found', status: 404 });
      }
      if (existing.userId !== userId) {
        throw new ForbiddenException({ title: 'Forbidden', status: 403 });
      }
      if (existing.endTime) {
        throw new BadRequestException({
          title: 'Cannot resume a stopped timer.',
          status: 400,
        });
      }
      if (!existing.pausedAt) {
        throw new BadRequestException({
          title: 'Timer is not paused.',
          status: 400,
        });
      }
      const now = new Date();
      const deltaMinutes = Math.max(
        0,
        Math.round((now.getTime() - existing.pausedAt.getTime()) / 60_000),
      );
      const row = await tx.timeEntry.update({
        where: { id: entryId },
        data: {
          pausedAt: null,
          accumulatedPauseMin: existing.accumulatedPauseMin + deltaMinutes,
        },
        include: ENTRY_INCLUDE,
      });
      return this.mapRow(row);
    });
  }

  async create(
    userId: string,
    workspaceId: string,
    input: CreateTimeEntryInput,
  ): Promise<TimeEntryWithMeta> {
    if (input.projectId) {
      await this.assertProjectAccessibleToUser(userId, input.projectId);
    }
    if (input.taskId) {
      await this.assertTaskInProject(userId, input.taskId, input.projectId);
    }
    const durationMin = Math.max(
      0,
      Math.round((input.endTime.getTime() - input.startTime.getTime()) / 60_000),
    );
    const projectLabel = input.projectLabel?.trim();
    const taskLabel = input.taskLabel?.trim();
    const row = await this.prisma.client.timeEntry.create({
      data: {
        userId,
        workspaceId,
        projectId: input.projectId ?? null,
        projectLabel: input.projectId
          ? null
          : projectLabel && projectLabel.length > 0
            ? projectLabel
            : null,
        taskId: input.taskId ?? null,
        taskLabel: input.taskId
          ? null
          : taskLabel && taskLabel.length > 0
            ? taskLabel
            : null,
        description: input.description ?? null,
        startTime: input.startTime,
        endTime: input.endTime,
        durationMin,
        billable: input.billable ?? true,
      },
      include: ENTRY_INCLUDE,
    });
    await this.autoMarkAttendance(userId, row.startTime);
    return this.mapRow(row);
  }

  async update(
    userId: string,
    workspaceId: string,
    entryId: string,
    input: UpdateTimeEntryInput,
  ): Promise<TimeEntryWithMeta> {
    const existing = await this.prisma.client.timeEntry.findFirst({
      where: { id: entryId, deletedAt: null },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Time entry not found', status: 404 });
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    if (input.projectId !== undefined && input.projectId !== null) {
      await this.assertProjectAccessibleToUser(userId, input.projectId);
    }
    if (input.taskId !== undefined && input.taskId !== null) {
      const targetProjectId =
        input.projectId !== undefined ? input.projectId : existing.projectId;
      await this.assertTaskInProject(userId, input.taskId, targetProjectId ?? undefined);
    }
    const data: Prisma.TimeEntryUpdateInput = {};
    if (input.projectId !== undefined) {
      data.project = input.projectId
        ? { connect: { id: input.projectId } }
        : { disconnect: true };
      // Clear any leftover free-text label when a concrete project takes over.
      if (input.projectId) data.projectLabel = null;
    }
    if (input.projectLabel !== undefined) {
      const trimmed = input.projectLabel?.trim() ?? null;
      data.projectLabel = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (input.taskId !== undefined) {
      data.task = input.taskId
        ? { connect: { id: input.taskId } }
        : { disconnect: true };
      // Drop any free-text label when a concrete task takes over.
      if (input.taskId) data.taskLabel = null;
    }
    if (input.taskLabel !== undefined) {
      const trimmed = input.taskLabel?.trim() ?? null;
      data.taskLabel = trimmed && trimmed.length > 0 ? trimmed : null;
    }
    if (input.description !== undefined) data.description = input.description;
    if (input.startTime !== undefined) data.startTime = input.startTime;
    if (input.endTime !== undefined) data.endTime = input.endTime;
    if (input.billable !== undefined) data.billable = input.billable;

    const startTime = input.startTime ?? existing.startTime;
    const endTime =
      input.endTime !== undefined ? input.endTime : existing.endTime;
    if (endTime) {
      data.durationMin = Math.max(
        0,
        Math.round((endTime.getTime() - startTime.getTime()) / 60_000),
      );
    } else {
      data.durationMin = null;
    }

    const row = await this.prisma.client.timeEntry.update({
      where: { id: entryId },
      data,
      include: ENTRY_INCLUDE,
    });
    await this.autoMarkAttendance(row.userId, row.startTime);
    return this.mapRow(row);
  }

  async remove(userId: string, entryId: string): Promise<{ ok: true }> {
    const existing = await this.prisma.client.timeEntry.findFirst({
      where: { id: entryId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Time entry not found', status: 404 });
    }
    if (existing.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    await this.prisma.client.timeEntry.update({
      where: { id: entryId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async summary(
    actingUserId: string,
    _workspaceId: string,
    from: Date,
    to: Date,
    userIdOverride: string | undefined,
  ): Promise<TimesheetSummaryResponse> {
    const targetUserId = await this.resolveAdminTargetUser(
      actingUserId,
      userIdOverride,
    );
    // Summed in the database, one row per (project, label) pair, instead of
    // loading every entry. The pairs fold into the same buckets as before:
    // a project id wins, else a non-empty label, else "no project".
    const groups = await this.prisma.client.timeEntry.groupBy({
      by: ['projectId', 'projectLabel'],
      where: {
        userId: targetUserId,
        deletedAt: null,
        durationMin: { not: null },
        startTime: { gte: from, lte: to },
      },
      _sum: { durationMin: true },
      _count: { _all: true },
    });
    // Names and colours for the projects that appear. The bare client, like
    // the relation select this replaces: a soft-deleted project still names
    // the time logged against it.
    const projectIds = [
      ...new Set(groups.map((g) => g.projectId).filter((id): id is string => id != null)),
    ];
    const projects = projectIds.length
      ? await this.prisma.raw.project.findMany({
          where: { id: { in: projectIds } },
          select: { id: true, name: true, color: true },
        })
      : [];
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const byProject = new Map<
      string,
      { projectId: string | null; projectName: string | null; projectColor: string | null; totalMinutes: number; entryCount: number }
    >();
    let total = 0;
    for (const g of groups) {
      const labelKey = g.projectLabel ? `label:${g.projectLabel}` : null;
      const key = g.projectId ?? labelKey ?? '__none__';
      const project = g.projectId ? projectById.get(g.projectId) : undefined;
      const minutes = g._sum.durationMin ?? 0;
      const existing =
        byProject.get(key) ?? {
          projectId: g.projectId,
          projectName: project?.name ?? g.projectLabel ?? null,
          projectColor: project?.color ?? null,
          totalMinutes: 0,
          entryCount: 0,
        };
      existing.totalMinutes += minutes;
      existing.entryCount += g._count._all;
      total += minutes;
      byProject.set(key, existing);
    }
    return {
      totalMinutes: total,
      byProject: Array.from(byProject.values()).sort(
        (a, b) => b.totalMinutes - a.totalMinutes,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Admin (system-admin only)
  // -------------------------------------------------------------------------

  /**
   * List time entries for the admin caller's org - every admin, SUPER_ADMIN
   * included, sees only their own org's entries. (TimeEntry has no direct
   * organizationId, so we filter through the `user` relation.)
   */
  async adminList(
    actingUserId: string,
    query: AdminTimesheetsListQuery,
  ): Promise<{ items: TimeEntryWithMeta[] }> {
    const actor = await this.resolveActorOrg(actingUserId);
    const where: Prisma.TimeEntryWhereInput = {
      deletedAt: null,
      user: { organizationId: actor.organizationId },
    };
    if (query.userId) where.userId = query.userId;
    if (query.workspaceId) where.workspaceId = query.workspaceId;
    if (query.from || query.to) {
      where.startTime = {};
      if (query.from) (where.startTime as Prisma.DateTimeFilter).gte = query.from;
      if (query.to) (where.startTime as Prisma.DateTimeFilter).lte = query.to;
    }
    const rows = await this.prisma.client.timeEntry.findMany({
      where,
      orderBy: { startTime: 'desc' },
      include: ENTRY_INCLUDE,
      take: 1000,
    });
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * Attendance grid for the admin dashboard: each user × each day in the
   * window with total tracked minutes. Days with no entries appear with 0.
   * Days are the server clock's days. The DB sums per user and day, but the
   * half-open day boundaries are computed here in JS, so the grouping never
   * depends on the DB's timezone setting.
   */
  async adminAttendance(
    actingUserId: string,
    from: Date,
    to: Date,
  ): Promise<AdminAttendanceResponse> {
    const actor = await this.resolveActorOrg(actingUserId);
    // Inclusive list of yyyy-mm-dd strings between `from` and `to`.
    const dateRange: string[] = [];
    const cursor = startOfDay(from);
    const end = startOfDay(to);
    while (cursor.getTime() <= end.getTime()) {
      dateRange.push(toISODate(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    // Summed in the database per user and server-local day instead of loading
    // every entry. Day bucketing stays on the server clock, exactly as
    // `toISODate(startTime)` did it: JS computes the first instant of each
    // local day touched by [from, to], and Postgres only compares the stored
    // UTC instants against those boundaries (width_bucket), so neither the
    // DB's time zone nor DST enters into it. Bucket i (1-based) is the day
    // starting at dayStarts[i - 1].
    const dayStarts: Date[] = [];
    const dayKeys: string[] = [];
    const first = startOfDay(from);
    for (let i = 0; ; i += 1) {
      const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
      if (start.getTime() > to.getTime()) {
        dayStarts.push(start); // upper bound of the last day
        break;
      }
      dayStarts.push(start);
      dayKeys.push(toISODate(start));
    }
    const bounds = dayStarts.map(utcWallTime).join(',');
    // Every admin, SUPER_ADMIN included, sees only their own org. Same
    // relation filter as before: no `deletedAt` on User, it never had one.
    const orgFilter = Prisma.sql`AND t."userId" IN (SELECT u."id" FROM "User" u WHERE u."organizationId" = ${actor.organizationId})`;
    // `prisma.raw` has no soft-delete extension, so `deletedAt` is manual.
    const cells = await this.prisma.raw.$queryRaw<
      Array<{ userId: string; bucket: number; minutes: number; entries: number }>
    >`
      SELECT t."userId" AS "userId",
             width_bucket(t."startTime", string_to_array(${bounds}, ',')::timestamp(3)[]) AS bucket,
             SUM(t."durationMin")::int AS minutes,
             COUNT(*)::int AS entries
      FROM "TimeEntry" t
      WHERE t."deletedAt" IS NULL
        AND t."durationMin" IS NOT NULL
        AND t."startTime" >= ${utcWallTime(from)}::timestamp(3)
        AND t."startTime" <= ${utcWallTime(to)}::timestamp(3)
        ${orgFilter}
      GROUP BY 1, 2
    `;

    // The bare client, like the relation select this replaces.
    const userIds = [...new Set(cells.map((c) => c.userId))];
    const users = userIds.length
      ? await this.prisma.raw.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true, image: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    interface Acc {
      user: { id: string; name: string; email: string; image: string | null };
      totalMinutes: number;
      perDay: Map<string, { totalMinutes: number; entryCount: number }>;
    }
    const byUser = new Map<string, Acc>();
    for (const c of cells) {
      const user = userById.get(c.userId);
      if (!user) continue;
      const dayKey = dayKeys[Number(c.bucket) - 1];
      if (dayKey === undefined) continue; // unreachable: [from, to] lies inside the bounds
      const acc = byUser.get(c.userId) ?? {
        user,
        totalMinutes: 0,
        perDay: new Map<string, { totalMinutes: number; entryCount: number }>(),
      };
      const cell = acc.perDay.get(dayKey) ?? { totalMinutes: 0, entryCount: 0 };
      cell.totalMinutes += c.minutes;
      cell.entryCount += c.entries;
      acc.perDay.set(dayKey, cell);
      acc.totalMinutes += c.minutes;
      byUser.set(c.userId, acc);
    }

    const result = Array.from(byUser.values())
      .map((acc) => ({
        user: acc.user,
        totalMinutes: acc.totalMinutes,
        days: dateRange.map((date) => {
          const cell = acc.perDay.get(date) ?? { totalMinutes: 0, entryCount: 0 };
          return { date, ...cell };
        }),
      }))
      .sort((a, b) => b.totalMinutes - a.totalMinutes);

    return { from, to, dateRange, rows: result };
  }
}

/**
 * A `timestamp(3)` column holds UTC wall time. An ISO string without the
 * zone suffix casts (`::timestamp(3)`) to exactly that, whatever the DB
 * session's TimeZone is, so the raw query compares the same instants the
 * Prisma model query did without depending on how a bound Date is typed.
 */
function utcWallTime(d: Date): string {
  return d.toISOString().slice(0, 23);
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}
