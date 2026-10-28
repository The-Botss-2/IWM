import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  AttendanceMatrixQuery,
  AttendanceMatrixResponse,
  AttendanceReportQuery,
  AttendanceStatus,
  AttendanceSummaryResponse,
  AttendanceUsersResponse,
  OverrideAttendanceInput,
} from '@botss/shared-types';

import { AdminUsersService } from '../admin/admin-users.service';
import { PROCESS_ROLE, type ProcessRole, runsBackgroundWork } from '../common/process-role';
import { requestAuthFor } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import {
  ATTENDANCE_LOCK_TX_TIMEOUT_MS,
  derivedAttendanceStatus,
  isUtcWeekend,
  lockAttendanceLeaveWrites,
} from './attendance-precedence';
import { LeavesService } from './leaves.service';

/** Anomaly thresholds. Tracked-hours below this on a PRESENT day flag
 *  the row in the summary dashboard; days marked ABSENT that nonetheless
 *  carry time entries also flag. Both numbers are deliberately lenient
 *  so a 9-to-12 part-day doesn't trigger noise. */
const PRESENT_LOW_HOURS_THRESHOLD_MIN = 4 * 60;

/** Rows per createMany in the boot backfill (bounded bind-parameter count). */
const BACKFILL_CHUNK = 5000;

@Injectable()
export class AttendanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminUsersService,
    private readonly leaves: LeavesService,
    @Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all',
  ) {}

  /**
   * One-shot backfill on boot: any existing TimeEntry that has no
   * matching Attendance row gets stamped PRESENT. Idempotent -
   * `createMany({ skipDuplicates: true })` against the (userId, date)
   * unique index makes repeated runs a no-op, and existing rows
   * (manual overrides, LEAVE markers) are deliberately left untouched.
   *
   * Fire-and-forget: boot no longer waits for it (it used to hold up
   * `app.listen` while it read every TimeEntry). Errors are logged.
   *
   * Runs only in the background process (ROLE=all or worker), never in
   * ROLE=api, so a split deploy does it once per boot, not twice.
   */
  onApplicationBootstrap(): void {
    if (!runsBackgroundWork(this.role)) return;
    setImmediate(() => {
      void this.backfillAttendanceFromTimeEntries()
        .then((count) => {
          if (count > 0) {
            this.logger.log(
              `Attendance backfill on boot stamped ${count} PRESENT rows from historic timesheets.`,
            );
          }
        })
        .catch((err: unknown) => {
          this.logger.error(
            `Attendance backfill on boot failed message=${(err as Error)?.message ?? 'unknown'}`,
          );
        });
    });
  }

  /**
   * Active-users list for the HR / Admin Attendance Summary dashboard.
   * The matrix endpoint already pulls every active user; the summary
   * dropdown should match so the dashboard isn't artificially scoped
   * to whichever workspace the admin happens to be sitting in.
   */
  async listUsers(actingUserId: string): Promise<AttendanceUsersResponse> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgFilter = await this.resolveOrgFilter(actingUserId);
    return this.prisma.client.user.findMany({
      // Client-portal people have no attendance.
      where: { deletedAt: null, accountType: 'STAFF', ...orgFilter },
      select: { id: true, name: true, email: true, image: true },
      orderBy: [{ name: 'asc' }],
    });
  }

  /**
   * Tenant boundary for HR/admin attendance queries: every HR / ADMIN /
   * SUPER_ADMIN is restricted to their own org's users. Without this filter,
   * HR in Org A could pull the attendance matrix for Org B's staff. An
   * org-less actor matches nobody.
   */
  private async resolveOrgFilter(actingUserId: string): Promise<{ organizationId: string }> {
    // AuthGuard already read the actor's role and org for this request.
    const actor =
      requestAuthFor(actingUserId) ??
      (await this.prisma.client.user.findUnique({
        where: { id: actingUserId },
        select: { organizationId: true },
      }));
    return { organizationId: actor?.organizationId ?? '__none__' };
  }

  /**
   * Idempotent helper used by both the boot-time backfill and any
   * future manual trigger. Walks every non-deleted TimeEntry, derives
   * the unique (userId, UTC-midnight) pairs, and inserts missing
   * Attendance rows with status=PRESENT. Existing rows are kept as-is
   * so LEAVE / manual ABSENT overrides aren't clobbered.
   *
   * The dedupe and the "already has a row" check run in SQL, so only the
   * MISSING pairs come back - after the first run that is (almost) nothing,
   * instead of every TimeEntry ever recorded. `date_trunc('day', ...)` on the
   * UTC-stored timestamp is the same UTC midnight `startOfDay` computed. The
   * inserts still go through Prisma so ids stay cuids; `skipDuplicates`
   * keeps a concurrent cron/override from turning into an error.
   */
  async backfillAttendanceFromTimeEntries(): Promise<number> {
    const missing = await this.prisma.client.$queryRaw<Array<{ userId: string; date: Date }>>(
      Prisma.sql`
        SELECT DISTINCT te."userId", date_trunc('day', te."startTime") AS "date"
          FROM "TimeEntry" te
         WHERE te."deletedAt" IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM "Attendance" a
              WHERE a."userId" = te."userId"
                AND a."date" = date_trunc('day', te."startTime")
           )`,
    );
    if (missing.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < missing.length; i += BACKFILL_CHUNK) {
      const result = await this.prisma.client.attendance.createMany({
        data: missing.slice(i, i + BACKFILL_CHUNK).map((p) => ({
          userId: p.userId,
          date: p.date,
          status: 'PRESENT' as AttendanceStatus,
        })),
        skipDuplicates: true,
      });
      count += result.count;
    }
    return count;
  }

  /**
   * Per-user combined Attendance + TimeEntry summary for the picked
   * range. Standard employees can only query their own id; HR / Admin
   * can query any user. Day-by-day anomaly column lets the dashboard
   * highlight discrepancies (PRESENT with <4h, ABSENT with hours).
   */
  async summary(
    actingUserId: string,
    query: AttendanceReportQuery,
  ): Promise<AttendanceSummaryResponse> {
    if (query.userId !== actingUserId) {
      await this.admin.assertAdminOrHR(actingUserId);
      // Tenant boundary for HR/admin cross-user reads: the target must be
      // in the actor's org, SUPER_ADMIN included. Without this, HR in Org A
      // could fetch the full attendance summary for any Org B user by
      // passing their userId.
      const orgFilter = await this.resolveOrgFilter(actingUserId);
      const target = await this.prisma.client.user.findUnique({
        where: { id: query.userId },
        select: { organizationId: true },
      });
      if (target?.organizationId !== orgFilter.organizationId) {
        throw new ForbiddenException({
          title: 'User is outside your organization',
          status: 403,
        });
      }
    }
    const user = await this.prisma.client.user.findUnique({
      where: { id: query.userId },
      select: { id: true, name: true, email: true, image: true },
    });
    if (!user) {
      throw new ForbiddenException({ title: 'User not found', status: 404 });
    }
    const fromDay = startOfDay(query.from);
    const toDay = startOfDay(query.to);
    const toDayExclusive = new Date(toDay);
    toDayExclusive.setUTCDate(toDayExclusive.getUTCDate() + 1);

    const [attendance, entries, approvedLeaves, holidays] = await Promise.all([
      this.prisma.client.attendance.findMany({
        where: {
          userId: query.userId,
          date: { gte: fromDay, lte: toDay },
        },
      }),
      this.prisma.client.timeEntry.findMany({
        where: {
          userId: query.userId,
          deletedAt: null,
          startTime: { gte: fromDay, lt: toDayExclusive },
        },
        select: { startTime: true, durationMin: true },
      }),
      // Approved leaves overlapping the window. Overlaying these lets
      // today/future and freshly-approved leaves show up before the daily
      // cron has had a chance to stamp Attendance rows.
      this.prisma.client.leave.findMany({
        where: {
          userId: query.userId,
          status: 'APPROVED',
          startDate: { lte: toDay },
          endDate: { gte: fromDay },
        },
        select: { startDate: true, endDate: true },
      }),
      // Public holidays for this user's organisation overlapping the
      // window. Like the leave overlay, this lets a holiday show up
      // immediately after HR adds it — even before the daily cron has
      // run for that date.
      (async () => {
        const u = await this.prisma.client.user.findUnique({
          where: { id: query.userId },
          select: { organizationId: true },
        });
        if (!u?.organizationId) return [];
        return this.prisma.client.holiday.findMany({
          where: {
            organizationId: u.organizationId,
            date: { gte: fromDay, lte: toDay },
          },
          select: { date: true },
        });
      })(),
    ]);

    const minutesByDay = new Map<string, number>();
    for (const e of entries) {
      const key = toISODate(startOfDay(e.startTime));
      minutesByDay.set(key, (minutesByDay.get(key) ?? 0) + (e.durationMin ?? 0));
    }
    const statusByDay = new Map<string, AttendanceStatus>();
    for (const a of attendance) {
      statusByDay.set(toISODate(a.date), a.status);
    }
    // Approved-leave overlay wins over whatever the cron stamped (or
    // didn't stamp). Walk each leave window and mark every covered day.
    for (const lv of approvedLeaves) {
      const s = startOfDay(lv.startDate);
      const e = startOfDay(lv.endDate);
      const cursor = new Date(s.getTime() < fromDay.getTime() ? fromDay : s);
      const stop = e.getTime() > toDay.getTime() ? toDay : e;
      while (cursor.getTime() <= stop.getTime()) {
        statusByDay.set(toISODate(cursor), 'LEAVE');
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    // Holiday overlay wins over leave: a company-wide day off shouldn't
    // burn a personal balance. Applied last so it overrides both the
    // stored attendance row and the leave overlay.
    for (const h of holidays) {
      statusByDay.set(toISODate(startOfDay(h.date)), 'HOLIDAY');
    }

    const days: AttendanceSummaryResponse['days'] = [];
    let daysPresent = 0;
    let daysAbsent = 0;
    let daysLeave = 0;
    let daysHoliday = 0;
    let totalTrackedMinutes = 0;
    const cursor = new Date(fromDay);
    while (cursor.getTime() <= toDay.getTime()) {
      const key = toISODate(cursor);
      const status = statusByDay.get(key) ?? null;
      const minutes = minutesByDay.get(key) ?? 0;
      if (status === 'PRESENT') daysPresent++;
      else if (status === 'ABSENT') daysAbsent++;
      else if (status === 'LEAVE') daysLeave++;
      else if (status === 'HOLIDAY') daysHoliday++;
      totalTrackedMinutes += minutes;
      const anomaly: 'NONE' | 'PRESENT_LOW_HOURS' | 'ABSENT_HAS_HOURS' =
        status === 'PRESENT' && minutes < PRESENT_LOW_HOURS_THRESHOLD_MIN
          ? 'PRESENT_LOW_HOURS'
          : status === 'ABSENT' && minutes > 0
            ? 'ABSENT_HAS_HOURS'
            : 'NONE';
      days.push({ date: key, status, minutes, anomaly });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return {
      user,
      range: { from: fromDay, to: toDay },
      totalTrackedMinutes,
      daysPresent,
      daysAbsent,
      daysLeave,
      daysHoliday,
      days,
    };
  }

  /**
   * Cross-user attendance grid for the HR / Admin matrix page. One
   * row per active user, one cell per day in the window. Cells with
   * no recorded status come back as `null` - the cron writes a
   * status the next morning.
   */
  async matrix(
    actingUserId: string,
    query: AttendanceMatrixQuery,
  ): Promise<AttendanceMatrixResponse> {
    await this.admin.assertAdminOrHR(actingUserId);
    const orgFilter = await this.resolveOrgFilter(actingUserId);
    const fromDay = startOfDay(query.from);
    const toDay = startOfDay(query.to);
    const dateRange: string[] = [];
    const cursor = new Date(fromDay);
    while (cursor.getTime() <= toDay.getTime()) {
      dateRange.push(toISODate(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    // Resolve the in-scope user ids ONCE and reuse the set when filtering
    // Attendance / Leave rows by `userId`. Attendance and Leave have no
    // direct `organizationId` column - the tenant boundary lives on User -
    // so we have to constrain the join through a user-id whitelist.
    const inScopeUsers = await this.prisma.client.user.findMany({
      where: { deletedAt: null, accountType: 'STAFF', ...orgFilter },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        organizationId: true,
      },
      orderBy: [{ name: 'asc' }],
    });
    const inScopeUserIds = inScopeUsers.map((u) => u.id);
    const userIdFilter = { userId: { in: inScopeUserIds } };
    // Org-scope filter for the holiday lookup: the actor's own org only.
    // Resolved up-front and reused so we don't re-derive it per holiday.
    const actorOrgId = orgFilter.organizationId;

    const [users, rows, approvedLeaves, holidays] = await Promise.all([
      Promise.resolve(inScopeUsers),
      this.prisma.client.attendance.findMany({
        where: { date: { gte: fromDay, lte: toDay }, ...userIdFilter },
        select: { userId: true, date: true, status: true },
      }),
      this.prisma.client.leave.findMany({
        where: {
          status: 'APPROVED',
          startDate: { lte: toDay },
          endDate: { gte: fromDay },
          ...userIdFilter,
        },
        select: { userId: true, startDate: true, endDate: true },
      }),
      this.prisma.client.holiday.findMany({
        where: {
          date: { gte: fromDay, lte: toDay },
          organizationId: actorOrgId,
        },
        select: { organizationId: true, date: true },
      }),
    ]);

    // Map orgId → in-scope userIds so the holiday overlay below knows
    // which users to stamp without re-querying.
    const usersByOrg = new Map<string, string[]>();
    for (const u of inScopeUsers) {
      const list = usersByOrg.get((u as { organizationId?: string | null }).organizationId ?? '');
      if (list) {
        list.push(u.id);
      } else {
        usersByOrg.set((u as { organizationId?: string | null }).organizationId ?? '', [u.id]);
      }
    }
    const byUser = new Map<string, Map<string, AttendanceStatus>>();
    for (const r of rows) {
      let map = byUser.get(r.userId);
      if (!map) {
        map = new Map();
        byUser.set(r.userId, map);
      }
      map.set(toISODate(r.date), r.status);
    }
    // Overlay approved leaves so the matrix matches reality before the
    // cron has stamped Attendance rows for the affected days.
    for (const lv of approvedLeaves) {
      let map = byUser.get(lv.userId);
      if (!map) {
        map = new Map();
        byUser.set(lv.userId, map);
      }
      const s = startOfDay(lv.startDate);
      const e = startOfDay(lv.endDate);
      const cursor = new Date(s.getTime() < fromDay.getTime() ? fromDay : s);
      const stop = e.getTime() > toDay.getTime() ? toDay : e;
      while (cursor.getTime() <= stop.getTime()) {
        map.set(toISODate(cursor), 'LEAVE');
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    // Overlay holidays last so they win over both stored attendance and
    // the leave overlay. A company-wide day off takes precedence over
    // an individual booked-in-advance leave.
    for (const h of holidays) {
      const userIds = usersByOrg.get(h.organizationId) ?? [];
      const key = toISODate(startOfDay(h.date));
      for (const uid of userIds) {
        let map = byUser.get(uid);
        if (!map) {
          map = new Map();
          byUser.set(uid, map);
        }
        map.set(key, 'HOLIDAY');
      }
    }
    return {
      from: fromDay,
      to: toDay,
      dateRange,
      rows: users.map((u) => {
        const m = byUser.get(u.id);
        return {
          user: u,
          cells: dateRange.map((date) => ({
            date,
            status: m?.get(date) ?? null,
          })),
        };
      }),
    };
  }

  /**
   * Manual override / upsert. HR or Admin only. The (userId, date)
   * unique index makes this idempotent - repeated saves overwrite the
   * earlier row's status + notes + timestamp.
   */
  async override(actingUserId: string, input: OverrideAttendanceInput): Promise<{ ok: true }> {
    await this.admin.assertAdminOrHR(actingUserId);
    // HR/ADMIN/SUPER_ADMIN may only override attendance for users in their
    // own org. Without this, HR in Org A could forge attendance for a user
    // in Org B by passing their id.
    const orgFilter = await this.resolveOrgFilter(actingUserId);
    const target = await this.prisma.client.user.findUnique({
      where: { id: input.userId },
      select: { organizationId: true },
    });
    if (target?.organizationId !== orgFilter.organizationId) {
      throw new ForbiddenException({
        title: 'User is outside your organization',
        status: 403,
      });
    }
    const date = startOfDay(input.date);
    await this.prisma.client.attendance.upsert({
      where: { userId_date: { userId: input.userId, date } },
      create: {
        userId: input.userId,
        date,
        status: input.status,
        notes: input.notes ?? null,
      },
      update: {
        status: input.status,
        notes: input.notes ?? null,
      },
    });
    return { ok: true };
  }

  /**
   * Materialise attendance rows for the supplied UTC date. Called by
   * the cron service for "yesterday" once a day. Idempotent on
   * (userId, date) - `skipDuplicates` lets a re-run be a no-op.
   *
   * Algorithm per user:
   *   1. Is the day a `Holiday` for the user's organisation? → HOLIDAY
   *   2. Else, did an approved Leave window cover the day? → LEAVE
   *   3. Else, did they log any TimeEntry that started inside the day? → PRESENT
   *   4. Else, is it a weekday? → ABSENT
   *   5. Weekend with no activity → skip (no row written)
   *
   * Holidays take precedence over personal leaves: if HR sets Dec 25 as a
   * holiday after a user already booked Dec 25 as annual leave, the day
   * shouldn't drain the user's annual balance — it's a free day for
   * everyone. The leave row itself stays untouched in the DB so HR can
   * see the original intent; only the materialised `Attendance.status`
   * reflects the precedence.
   */
  async generateForDate(targetDate: Date): Promise<{ written: number; skipped: number }> {
    const day = startOfDay(targetDate);
    const dayExclusive = new Date(day);
    dayExclusive.setUTCDate(dayExclusive.getUTCDate() + 1);
    const isWeekend = isUtcWeekend(day);

    const users = await this.prisma.client.user.findMany({
      // Staff only: client-portal people must never get attendance rows.
      where: { deletedAt: null, accountType: 'STAFF' },
      select: { id: true, organizationId: true },
    });
    // Holiday lookup: a single query for all orgs on this day, then a
    // membership check per user. Keyed by `organizationId` so the per-user
    // check is O(1). User rows without an org (legacy / not-yet-onboarded)
    // can't be on a holiday — they fall through to the existing logic.
    const holidaysForDay = await this.prisma.client.holiday.findMany({
      where: { date: day },
      select: { organizationId: true },
    });
    const orgsOnHoliday = new Set(holidaysForDay.map((h) => h.organizationId));

    // Users who logged at least one entry that day.
    const entries = await this.prisma.client.timeEntry.groupBy({
      by: ['userId'],
      where: {
        deletedAt: null,
        startTime: { gte: day, lt: dayExclusive },
      },
      _count: { _all: true },
    });
    const workedUserIds = new Set(entries.map((e) => e.userId));

    // Reading the approved leaves and writing the rows happen under the
    // attendance/leave lock, so a leave rejected or deleted concurrently is
    // either seen as gone here, or finds the LEAVE rows written here and
    // reverts them (LeavesService.revertLeaveAttendance takes the same lock).
    const { written, skipped, attempted } = await this.prisma.client.$transaction(
      async (tx) => {
        await lockAttendanceLeaveWrites(tx);
        const leaves = await this.leaves.approvedLeavesCovering(day, tx);
        const leaveUserIds = new Set(leaves.map((l) => l.userId));
        const rows: { userId: string; date: Date; status: AttendanceStatus }[] = [];
        let skippedCount = 0;
        for (const u of users) {
          const status = derivedAttendanceStatus({
            onHoliday: u.organizationId !== null && orgsOnHoliday.has(u.organizationId),
            onLeave: leaveUserIds.has(u.id),
            worked: workedUserIds.has(u.id),
            isWeekend,
          });
          if (status) {
            rows.push({ userId: u.id, date: day, status });
          } else {
            skippedCount++;
          }
        }
        if (rows.length === 0) return { written: 0, skipped: skippedCount, attempted: false };
        const result = await tx.attendance.createMany({ data: rows, skipDuplicates: true });
        return { written: result.count, skipped: skippedCount, attempted: true };
      },
      { timeout: ATTENDANCE_LOCK_TX_TIMEOUT_MS },
    );
    if (attempted) {
      this.logger.log(
        `Attendance generated date=${toISODate(day)} written=${written} skipped=${skipped}`,
      );
    }
    return { written, skipped };
  }
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function toISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}
