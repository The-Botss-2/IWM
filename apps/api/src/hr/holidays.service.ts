import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  ApplyHolidayResponse,
  CreateHolidayInput,
  Holiday,
  HolidayListResponse,
  HolidayRevertStatus,
  ListHolidaysQuery,
  UpdateHolidayInput,
} from '@botss/shared-types';

import { AdminUsersService } from '../admin/admin-users.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTENDANCE_LOCK_TX_TIMEOUT_MS,
  LEAVE_REVERT_NOTE_PREFIX,
  lockAttendanceLeaveWrites,
} from './attendance-precedence';
import { LeavesService } from './leaves.service';

/**
 * Public holidays per organisation.
 *
 * Distinct from `Leave`:
 *   - applies to the *whole org* automatically (cron stamps every member);
 *   - doesn't consume a personal leave balance;
 *   - represented in `Attendance.status` as a separate `HOLIDAY` value.
 *
 * Authorisation: HR or Admin within the holiday's organisation. Root-org
 * global admins can target any org by membership. Cross-org access is
 * blocked at the service layer — never trust the controller's URL.
 */
@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminUsersService,
    private readonly leaves: LeavesService,
  ) {}

  /**
   * The acting user's organisation. Root-org global admins fall back to
   * the root org for create/update operations; if they want to write
   * holidays for a different tenant they'd do so through the workspace
   * switcher (out of scope for the v1 UI).
   */
  private async actorOrgId(actingUserId: string): Promise<string> {
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { organizationId: true },
    });
    if (!actor?.organizationId) {
      throw new ForbiddenException({
        title: 'No organization context',
        status: 403,
      });
    }
    return actor.organizationId;
  }

  async list(
    actingUserId: string,
    query: ListHolidaysQuery,
  ): Promise<HolidayListResponse> {
    // Any signed-in user can read holidays for their own org (the
    // attendance grid surfaces them). Cross-org reads are blocked
    // implicitly by the orgId filter.
    const orgId = await this.actorOrgId(actingUserId);
    const where: { organizationId: string; date?: { gte?: Date; lte?: Date } } = {
      organizationId: orgId,
    };
    if (query.from || query.to) {
      where.date = {};
      if (query.from) where.date.gte = startOfDay(query.from);
      if (query.to) where.date.lte = startOfDay(query.to);
    }
    const items = await this.prisma.client.holiday.findMany({
      where,
      orderBy: [{ date: 'asc' }],
    });
    return { items };
  }

  /**
   * Create a holiday and (optionally) retroactively stamp every active
   * org member's `Attendance.status` as `HOLIDAY` for that date. Returns
   * the row plus a count of attendance rows created vs overwritten so
   * the toast can be accurate.
   *
   * Idempotent: re-running for the same `(organizationId, date)` returns
   * the existing row and only writes attendance rows for users who
   * didn't have one yet.
   */
  async create(
    actingUserId: string,
    input: CreateHolidayInput,
  ): Promise<ApplyHolidayResponse> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgId = await this.actorOrgId(actingUserId);
    const date = startOfDay(input.date);

    // Upsert so re-running silently no-ops on the natural key.
    const holiday = await this.prisma.client.holiday.upsert({
      where: {
        organizationId_date: { organizationId: orgId, date },
      },
      create: {
        organizationId: orgId,
        date,
        name: input.name,
        notes: input.notes ?? null,
        createdById: actingUserId,
      },
      update: {
        name: input.name,
        notes: input.notes ?? null,
      },
    });

    if (!input.applyToAttendance) {
      return { holiday, attendanceCreated: 0, attendanceUpdated: 0 };
    }

    const counts = await this.applyToAttendance(orgId, date);
    return { holiday, ...counts };
  }

  async update(
    actingUserId: string,
    holidayId: string,
    input: UpdateHolidayInput,
  ): Promise<Holiday> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgId = await this.actorOrgId(actingUserId);
    const existing = await this.prisma.client.holiday.findUnique({
      where: { id: holidayId },
    });
    if (!existing || existing.organizationId !== orgId) {
      throw new NotFoundException({ title: 'Holiday not found', status: 404 });
    }
    return this.prisma.client.holiday.update({
      where: { id: holidayId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
  }

  /**
   * Remove a holiday and revert the attendance rows it stamped back to
   * what they would otherwise be. `applyToAttendance` overwrote each
   * member's status with HOLIDAY (destroying the prior value), so we
   * can't literally restore the old row — instead we *recompute* the
   * status using the same precedence the daily cron uses, minus the
   * now-deleted holiday:
   *
   *   approved LEAVE covers the day → LEAVE
   *   logged a TimeEntry that day   → PRESENT
   *   weekday, no activity          → ABSENT
   *   weekend, no activity          → row deleted (back to unmarked)
   *
   * Only rows still marked HOLIDAY for this date are touched — if HR has
   * since manually changed a row to something else, that override stands.
   *
   * Deleting a holiday *clears* the attendance it stamped (the rows are
   * removed, leaving the day unmarked for everyone) rather than recomputing
   * a weekday into ABSENT — deleting the holiday means it should leave no
   * trace. HR who want a specific status use Unmark instead.
   */
  async remove(actingUserId: string, holidayId: string): Promise<{ ok: true }> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgId = await this.actorOrgId(actingUserId);
    const existing = await this.prisma.client.holiday.findUnique({
      where: { id: holidayId },
    });
    if (!existing || existing.organizationId !== orgId) {
      throw new NotFoundException({ title: 'Holiday not found', status: 404 });
    }
    const date = startOfDay(existing.date);
    await this.prisma.client.holiday.delete({ where: { id: holidayId } });
    await this.revertAttendanceForDate(orgId, date, 'CLEAR');
    return { ok: true };
  }

  /**
   * Unmark a holiday's attendance without deleting the holiday entry: revert
   * every row still stamped HOLIDAY for that date back to its recomputed
   * status (present / absent / leave / unmarked). The inverse of `apply`.
   *
   * Note: the holiday definition stays, so the daily cron will re-stamp the
   * date as HOLIDAY again once it actually arrives - this is for correcting an
   * already-applied (today/past) date. Delete the holiday to stop that.
   */
  async unmark(
    actingUserId: string,
    holidayId: string,
    status?: HolidayRevertStatus,
  ): Promise<{ ok: true }> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgId = await this.actorOrgId(actingUserId);
    const existing = await this.prisma.client.holiday.findUnique({
      where: { id: holidayId },
    });
    if (!existing || existing.organizationId !== orgId) {
      throw new NotFoundException({ title: 'Holiday not found', status: 404 });
    }
    await this.revertAttendanceForDate(orgId, startOfDay(existing.date), status);
    return { ok: true };
  }

  /**
   * Internal: undo the HOLIDAY stamp for one org+date.
   *
   * When `override` is given, every still-HOLIDAY row for the date is forced
   * to that single outcome: `CLEAR` deletes the rows (day becomes unmarked),
   * `PRESENT` / `ABSENT` / `LEAVE` set them all to that status. This is what
   * HR's Unmark chooser uses so the result is predictable for the whole org.
   *
   * Without an override (the legacy path) it mirrors the daily cron's status
   * precedence so the grid lands in the state it would have reached on its
   * own: approved leave → LEAVE, logged time → PRESENT, weekday → ABSENT,
   * weekend → row deleted.
   */
  private async revertAttendanceForDate(
    orgId: string,
    date: Date,
    override?: HolidayRevertStatus,
  ): Promise<void> {
    const day = startOfDay(date);
    const dayExclusive = new Date(day);
    dayExclusive.setUTCDate(dayExclusive.getUTCDate() + 1);
    const dow = day.getUTCDay(); // 0 = Sun, 6 = Sat
    const isWeekend = dow === 0 || dow === 6;

    const users = await this.prisma.client.user.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (users.length === 0) return;
    const userIds = users.map((u) => u.id);

    // Only revert rows still stamped HOLIDAY for this date; a manual HR
    // change since then takes precedence and is left alone.
    const holidayRows = await this.prisma.client.attendance.findMany({
      where: { userId: { in: userIds }, date: day, status: 'HOLIDAY' },
      select: { userId: true },
    });
    if (holidayRows.length === 0) return;
    const affected = holidayRows.map((r) => r.userId);

    // Explicit override: one outcome for every affected row, no recompute.
    if (override) {
      if (override === 'CLEAR') {
        await this.prisma.client.attendance.deleteMany({
          where: { userId: { in: affected }, date: day, status: 'HOLIDAY' },
        });
      } else {
        await this.prisma.client.attendance.updateMany({
          where: { userId: { in: affected }, date: day, status: 'HOLIDAY' },
          data: { status: override },
        });
      }
      this.logger.log(
        `Holiday revert (override=${override}) org=${orgId} ` +
          `date=${day.toISOString().slice(0, 10)} affected=${affected.length}`,
      );
      return;
    }

    // Recompute the would-be status per affected user (cron precedence,
    // minus the holiday which is already gone).
    const entries = await this.prisma.client.timeEntry.groupBy({
      by: ['userId'],
      where: {
        deletedAt: null,
        userId: { in: affected },
        startTime: { gte: day, lt: dayExclusive },
      },
      _count: { _all: true },
    });
    const workedUserIds = new Set(entries.map((e) => e.userId));

    const toLeave: string[] = [];
    const toPresent: string[] = [];
    const toAbsent: string[] = [];
    const toDelete: string[] = [];
    // Reading approved leaves and writing LEAVE rows happen under the
    // attendance/leave lock, like the daily cron: a leave rejected or deleted
    // meanwhile is either seen as gone here, or finds the LEAVE row written
    // here and reverts it.
    await this.prisma.client.$transaction(
      async (tx) => {
        await lockAttendanceLeaveWrites(tx);
        const leaves = await this.leaves.approvedLeavesCovering(day, tx);
        const leaveUserIds = new Set(leaves.map((l) => l.userId));
        for (const uid of affected) {
          if (leaveUserIds.has(uid)) toLeave.push(uid);
          else if (workedUserIds.has(uid)) toPresent.push(uid);
          else if (!isWeekend) toAbsent.push(uid);
          else toDelete.push(uid);
        }
        if (toLeave.length > 0) {
          const where = { userId: { in: toLeave }, date: day, status: 'HOLIDAY' as const };
          // A row carrying LeavesService's own revert note goes back to a
          // plain system LEAVE row (note cleared), so a later reject/delete
          // of this leave still reverts it. HR-written notes are kept.
          await tx.attendance.updateMany({
            where: { ...where, notes: { startsWith: LEAVE_REVERT_NOTE_PREFIX } },
            data: { status: 'LEAVE', notes: null },
          });
          await tx.attendance.updateMany({ where, data: { status: 'LEAVE' } });
        }
        const groups = [
          [toPresent, 'PRESENT'],
          [toAbsent, 'ABSENT'],
        ] as const;
        for (const [ids, status] of groups) {
          if (ids.length === 0) continue;
          await tx.attendance.updateMany({
            where: { userId: { in: ids }, date: day, status: 'HOLIDAY' },
            data: { status },
          });
        }
        if (toDelete.length > 0) {
          await tx.attendance.deleteMany({
            where: { userId: { in: toDelete }, date: day, status: 'HOLIDAY' },
          });
        }
      },
      { timeout: ATTENDANCE_LOCK_TX_TIMEOUT_MS },
    );

    this.logger.log(
      `Holiday revert org=${orgId} date=${day.toISOString().slice(0, 10)} ` +
        `leave=${toLeave.length} present=${toPresent.length} ` +
        `absent=${toAbsent.length} deleted=${toDelete.length}`,
    );
  }

  /**
   * Re-apply an existing holiday's attendance rows. Useful when HR has
   * onboarded new users between adding the holiday and the date arriving
   * — the cron handles future dates automatically but a one-click
   * "re-apply" makes the workflow explicit.
   */
  async apply(
    actingUserId: string,
    holidayId: string,
  ): Promise<ApplyHolidayResponse> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgId = await this.actorOrgId(actingUserId);
    const holiday = await this.prisma.client.holiday.findUnique({
      where: { id: holidayId },
    });
    if (!holiday || holiday.organizationId !== orgId) {
      throw new NotFoundException({ title: 'Holiday not found', status: 404 });
    }
    const counts = await this.applyToAttendance(orgId, holiday.date);
    return { holiday, ...counts };
  }

  /**
   * Internal: stamp `Attendance.status = HOLIDAY` for every active user
   * in the org for the given date. Existing rows get overwritten — a
   * holiday takes precedence over the cron's PRESENT/ABSENT call. Manual
   * LEAVE overrides set by HR are also overwritten on purpose: if HR
   * later declares the day a holiday, the company-wide status wins.
   * `notes` is preserved when a row already existed so HR's audit trail
   * doesn't disappear.
   */
  private async applyToAttendance(
    orgId: string,
    date: Date,
  ): Promise<{ attendanceCreated: number; attendanceUpdated: number }> {
    const users = await this.prisma.client.user.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (users.length === 0) {
      return { attendanceCreated: 0, attendanceUpdated: 0 };
    }
    // Read existing attendance for the day across this user set so we
    // can split create-vs-update for the response counts.
    const userIds = users.map((u) => u.id);
    const existing = await this.prisma.client.attendance.findMany({
      where: { userId: { in: userIds }, date },
      select: { userId: true, status: true },
    });
    const existingSet = new Set(existing.map((r) => r.userId));

    // updateMany over the existing set first (cheap row-update with no
    // unique-violation risk), then createMany skipDuplicates for the
    // rest.
    let updated = 0;
    if (existingSet.size > 0) {
      const res = await this.prisma.client.attendance.updateMany({
        where: { userId: { in: [...existingSet] }, date },
        data: { status: 'HOLIDAY' },
      });
      updated = res.count;
    }
    const toCreate = users
      .filter((u) => !existingSet.has(u.id))
      .map((u) => ({ userId: u.id, date, status: 'HOLIDAY' as const }));
    let created = 0;
    if (toCreate.length > 0) {
      const res = await this.prisma.client.attendance.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
      created = res.count;
    }
    this.logger.log(
      `Holiday applied org=${orgId} date=${date.toISOString().slice(0, 10)} created=${created} updated=${updated}`,
    );
    return { attendanceCreated: created, attendanceUpdated: updated };
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}
