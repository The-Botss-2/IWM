import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  CreateLeaveInput,
  Leave,
  LeaveListResponse,
  LeaveWithRefs,
  ListLeavesQuery,
  UpdateLeaveStatusInput,
} from '@botss/shared-types';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { userHasCompanyPermission } from '../common/permissions/effective-permissions';
import {
  ATTENDANCE_LOCK_TX_TIMEOUT_MS,
  type AttendanceTx,
  derivedAttendanceStatus,
  isUtcWeekend,
  LEAVE_REVERT_NOTE_PREFIX,
  lockAttendanceLeaveWrites,
} from './attendance-precedence';

const LEAVE_INCLUDE = {
  user: { select: { id: true, name: true, email: true, image: true } },
  approvedBy: { select: { id: true, name: true, email: true } },
} satisfies Prisma.LeaveInclude;

@Injectable()
export class LeavesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private mapRow(row: Prisma.LeaveGetPayload<{ include: typeof LEAVE_INCLUDE }>): LeaveWithRefs {
    return {
      id: row.id,
      userId: row.userId,
      startDate: row.startDate,
      endDate: row.endDate,
      type: row.type,
      status: row.status,
      reason: row.reason,
      approvedById: row.approvedById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      user: row.user,
      approvedBy: row.approvedBy,
    };
  }

  /**
   * List leaves. Standard employees can only see their own rows; HR /
   * ADMIN / SUPER_ADMIN see their own organization, never another. If a
   * privileged caller passes an explicit
   * `userId` we still confirm that target user is inside the caller's
   * tenant - without that check, HR in Org A could pull leaves for any
   * Org B user just by guessing an id.
   */
  async list(actingUserId: string, query: ListLeavesQuery): Promise<LeaveListResponse> {
    const role = await this.resolveActorRole(actingUserId);
    const where: Prisma.LeaveWhereInput = {};
    if (role.isPrivileged) {
      if (query.userId) {
        if (!(await this.userInOrg(query.userId, role.orgId))) {
          throw new ForbiddenException({
            title: 'User is outside your organization',
            status: 403,
          });
        }
        where.userId = query.userId;
      } else {
        where.user = { organizationId: role.orgId };
      }
    } else {
      // Strictly enforce self-scope. Even if the caller passed a
      // `userId`, we ignore it and force their own id.
      where.userId = actingUserId;
    }
    if (query.status) where.status = query.status;
    if (query.from || query.to) {
      const dateFilter: Prisma.DateTimeFilter = {};
      if (query.from) dateFilter.gte = query.from;
      if (query.to) dateFilter.lte = query.to;
      // We use startDate as the index handle but match any overlapping
      // leave window with the (startDate, endDate) tuple. For simplicity
      // we restrict to start within the range; full overlap detection is
      // overkill for the dashboards consuming this.
      where.startDate = dateFilter;
    }
    const rows = await this.prisma.client.leave.findMany({
      where,
      orderBy: [{ status: 'asc' }, { startDate: 'desc' }],
      include: LEAVE_INCLUDE,
      take: 500,
    });
    return { items: rows.map((r) => this.mapRow(r)) };
  }

  /**
   * Create a leave request. Employees implicitly request for themselves;
   * HR / Admin may pass an explicit `userId` to create on behalf of any
   * employee (e.g. when a manager records a verbal sick-leave call-in).
   */
  async create(actingUserId: string, input: CreateLeaveInput): Promise<LeaveWithRefs> {
    const role = await this.resolveActorRole(actingUserId);
    const targetUserId =
      input.userId && input.userId !== actingUserId
        ? role.isPrivileged
          ? input.userId
          : (() => {
              throw new ForbiddenException({
                title: 'Cannot file leave for another user.',
                status: 403,
              });
            })()
        : actingUserId;
    // If the actor is a privileged user filing on someone else's behalf,
    // the target must live inside the actor's org (no SUPER_ADMIN bypass).
    if (
      role.isPrivileged &&
      targetUserId !== actingUserId &&
      !(await this.userInOrg(targetUserId, role.orgId))
    ) {
      throw new ForbiddenException({
        title: 'Target user is outside your organization',
        status: 403,
      });
    }
    // Normalize the dates to UTC midnight so cron + matrix queries match
    // attendance rows row-for-row.
    const startDate = startOfDay(input.startDate);
    const endDate = startOfDay(input.endDate);
    if (endDate.getTime() < startDate.getTime()) {
      throw new BadRequestException({
        title: 'End date must be on or after start date.',
        status: 400,
      });
    }
    const created = await this.prisma.client.leave.create({
      data: {
        userId: targetUserId,
        startDate,
        endDate,
        type: input.type,
        reason: input.reason ?? null,
        // HR / Admin creating on someone else's behalf is treated as a
        // pre-approval - saves the round-trip. Self-requests stay PENDING.
        status: role.isPrivileged && targetUserId !== actingUserId ? 'APPROVED' : 'PENDING',
        approvedById: role.isPrivileged && targetUserId !== actingUserId ? actingUserId : null,
      },
      include: LEAVE_INCLUDE,
    });
    return this.mapRow(created);
  }

  /**
   * Decide a request (APPROVED / REJECTED). Requires `hr.leave.approve`
   * inside an organization - managing users or attendance is not enough -
   * and nobody decides their own request.
   */
  async updateStatus(
    actingUserId: string,
    leaveId: string,
    input: UpdateLeaveStatusInput,
  ): Promise<LeaveWithRefs> {
    const role = await this.resolveActorRole(actingUserId);
    if (!role.isPrivileged) {
      throw new ForbiddenException({
        title: 'Only HR can decide leave requests',
        status: 403,
        detail: 'Deciding a leave request needs the "Approve leave" permission.',
      });
    }
    const existing = await this.prisma.client.leave.findUnique({
      where: { id: leaveId },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Leave not found', status: 404 });
    }
    if (existing.userId === actingUserId) {
      throw new ForbiddenException({
        title: "You can't decide your own leave request",
        status: 403,
      });
    }
    // Tenant boundary: the target user must be inside the actor's org. No
    // SUPER_ADMIN bypass.
    if (!(await this.userInOrg(existing.userId, role.orgId))) {
      throw new ForbiddenException({
        title: 'Leave belongs to a user outside your organization',
        status: 403,
      });
    }
    const updated = await this.prisma.client.$transaction(
      async (tx) => {
        // Lock first, then read the status this decision replaces: the
        // attendance cron and other decisions are serialized behind it.
        await lockAttendanceLeaveWrites(tx);
        const before = await tx.leave.findUnique({
          where: { id: leaveId },
          select: { status: true },
        });
        if (!before) {
          throw new NotFoundException({ title: 'Leave not found', status: 404 });
        }
        const row = await tx.leave.update({
          where: { id: leaveId },
          data: {
            status: input.status,
            approvedById: actingUserId,
          },
          include: LEAVE_INCLUDE,
        });
        if (before.status === 'APPROVED' && input.status !== 'APPROVED') {
          await revertLeaveAttendance(tx, existing, 'rejected');
        }
        return row;
      },
      { timeout: ATTENDANCE_LOCK_TX_TIMEOUT_MS },
    );

    // Tell the employee their request was decided (unless they decided it).
    if (existing.userId !== actingUserId) {
      void this.notifications
        .emit({
          userId: existing.userId,
          actorId: actingUserId,
          type: 'LEAVE_DECISION',
          title: `Leave request ${input.status === 'APPROVED' ? 'approved' : 'rejected'}`,
          body: `Your leave request was ${input.status === 'APPROVED' ? 'approved' : 'rejected'}.`,
          entityType: 'leave',
          entityId: leaveId,
          url: '/timesheets/leave',
        })
        .catch(() => {});
    }
    return this.mapRow(updated);
  }

  async remove(actingUserId: string, leaveId: string): Promise<{ ok: true }> {
    const existing = await this.prisma.client.leave.findUnique({
      where: { id: leaveId },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Leave not found', status: 404 });
    }
    const role = await this.resolveActorRole(actingUserId);
    if (!role.isPrivileged && existing.userId !== actingUserId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    // Tenant boundary for privileged deletes: the leave's user must be in
    // the actor's org (no SUPER_ADMIN bypass).
    if (
      role.isPrivileged &&
      existing.userId !== actingUserId &&
      !(await this.userInOrg(existing.userId, role.orgId))
    ) {
      throw new ForbiddenException({
        title: 'Leave belongs to a user outside your organization',
        status: 403,
      });
    }
    // Employees can delete their own PENDING requests; once approved /
    // rejected, only HR can remove the audit row.
    if (!role.isPrivileged && existing.userId === actingUserId && existing.status !== 'PENDING') {
      throw new ForbiddenException({
        title: 'Cannot delete a processed leave request.',
        status: 403,
      });
    }
    await this.prisma.client.$transaction(
      async (tx) => {
        await lockAttendanceLeaveWrites(tx);
        const before = await tx.leave.findUnique({
          where: { id: leaveId },
          select: { status: true },
        });
        if (!before) {
          throw new NotFoundException({ title: 'Leave not found', status: 404 });
        }
        // Same rule as above, on the locked read: HR may have decided the
        // request since the first read.
        if (!role.isPrivileged && before.status !== 'PENDING') {
          throw new ForbiddenException({
            title: 'Cannot delete a processed leave request.',
            status: 403,
          });
        }
        await tx.leave.delete({ where: { id: leaveId } });
        if (before.status === 'APPROVED') {
          await revertLeaveAttendance(tx, existing, 'deleted');
        }
      },
      { timeout: ATTENDANCE_LOCK_TX_TIMEOUT_MS },
    );
    return { ok: true };
  }

  /**
   * Return all APPROVED leaves that cover a given UTC day. Consumed by
   * the attendance cron + summary endpoints. Cheap query: hits the
   * (startDate, endDate) compound index.
   */
  async approvedLeavesCovering(
    date: Date,
    /** Read inside this transaction (the cron's locked one) instead. */
    db: Pick<AttendanceTx, 'leave'> = this.prisma.client,
  ): Promise<Leave[]> {
    const utcMidnight = startOfDay(date);
    return (await db.leave.findMany({
      where: {
        status: 'APPROVED',
        startDate: { lte: utcMidnight },
        endDate: { gte: utcMidnight },
      },
    })) as Leave[];
  }

  /**
   * One trip to the DB to figure out who the actor is from a leave-policy
   * standpoint. `isPrivileged` matches the old `isAdminOrHR` semantics
   * (ADMIN or HR can act on others), always confined to the actor's own
   * organization - SUPER_ADMIN included, which holds `hr.leave.approve`
   * and so is privileged inside the root org only.
   */
  private async resolveActorRole(
    userId: string,
  ): Promise<
    { isPrivileged: true; orgId: string } | { isPrivileged: false; orgId: string | null }
  > {
    const u = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    const orgId = u?.organizationId ?? null;
    // Privileged only INSIDE an organization: an org-less ADMIN / HR account
    // is self-scoped, so a privileged actor always carries an org filter.
    if (orgId && (await userHasCompanyPermission(userId, 'hr.leave.approve'))) {
      return { isPrivileged: true, orgId };
    }
    // A non-privileged user's orgId is irrelevant (we force self-scope
    // anyway) but we still return it for symmetry.
    return { isPrivileged: false, orgId };
  }

  private async userInOrg(userId: string, orgId: string): Promise<boolean> {
    const target = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    return target?.organizationId === orgId;
  }
}

/**
 * A leave stopped being approved (rejected or deleted after approval): put
 * back the LEAVE attendance rows the system stamped for it.
 *
 * Only rows that are still LEAVE and carry no notes are touched. The daily
 * cron and the holiday recompute never leave a note on a LEAVE row (the
 * recompute clears our own revert note when it sets LEAVE again), while an
 * HR override normally has one. A row whose day is still covered by another
 * approved leave of the same person stays LEAVE. Everything else gets the
 * status the cron would compute now (holiday, logged time, weekday ABSENT);
 * a weekend with no activity has no row, so that row is deleted. Changed
 * rows get a note (LEAVE_REVERT_NOTE_PREFIX ...) saying why, so the
 * attendance history explains itself.
 *
 * Limitations, both about telling HR's rows from system rows:
 *  - a LEAVE row that keeps an HR-written note (from an override, or carried
 *    through a holiday mark + unmark) is left alone;
 *  - an HR override to LEAVE saved WITHOUT a note inside the leave's range
 *    looks exactly like a cron row and is reverted too.
 */
async function revertLeaveAttendance(
  tx: AttendanceTx,
  leave: { id: string; userId: string; startDate: Date; endDate: Date },
  reason: 'rejected' | 'deleted',
): Promise<void> {
  const from = startOfDay(leave.startDate);
  const to = startOfDay(leave.endDate);
  const rows = await tx.attendance.findMany({
    where: {
      userId: leave.userId,
      date: { gte: from, lte: to },
      status: 'LEAVE',
      notes: null,
    },
    select: { id: true, date: true },
  });
  if (rows.length === 0) return;

  const toExclusive = new Date(to);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);
  const user = await tx.user.findUnique({
    where: { id: leave.userId },
    select: { organizationId: true },
  });
  const [otherLeaves, holidays, entries] = await Promise.all([
    tx.leave.findMany({
      where: {
        userId: leave.userId,
        id: { not: leave.id },
        status: 'APPROVED',
        startDate: { lte: to },
        endDate: { gte: from },
      },
      select: { startDate: true, endDate: true },
    }),
    user?.organizationId
      ? tx.holiday.findMany({
          where: { organizationId: user.organizationId, date: { gte: from, lte: to } },
          select: { date: true },
        })
      : Promise.resolve([]),
    tx.timeEntry.findMany({
      where: {
        userId: leave.userId,
        deletedAt: null,
        startTime: { gte: from, lt: toExclusive },
      },
      select: { startTime: true },
    }),
  ]);
  const holidayDays = new Set(holidays.map((h) => startOfDay(h.date).getTime()));
  const workedDays = new Set(entries.map((e) => startOfDay(e.startTime).getTime()));
  const note = `${LEAVE_REVERT_NOTE_PREFIX} the leave request was ${reason} on ${new Date().toISOString().slice(0, 10)}.`;

  for (const row of rows) {
    const day = startOfDay(row.date).getTime();
    const status = derivedAttendanceStatus({
      onHoliday: holidayDays.has(day),
      onLeave: otherLeaves.some(
        (l) => startOfDay(l.startDate).getTime() <= day && startOfDay(l.endDate).getTime() >= day,
      ),
      worked: workedDays.has(day),
      isWeekend: isUtcWeekend(row.date),
    });
    if (status === 'LEAVE') continue;
    // Re-check status + notes in the write so a concurrent HR override wins.
    const guard = { id: row.id, status: 'LEAVE' as const, notes: null };
    if (status === null) {
      await tx.attendance.deleteMany({ where: guard });
    } else {
      await tx.attendance.updateMany({ where: guard, data: { status, notes: note } });
    }
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
