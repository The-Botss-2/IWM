/**
 * Leave decision self-checks (no database). LeavesService runs against an
 * in-memory fake Prisma inside a request context, the way AuthGuard leaves
 * a request. Covered:
 *  - deciding a request needs `hr.leave.approve`: managing users or
 *    attendance is not enough, and a refusal writes nothing;
 *  - nobody decides their own request, HR included;
 *  - HR of another organization is refused;
 *  - the decision notification links to /timesheets/leave;
 *  - rejecting or deleting an approved leave puts its system-stamped LEAVE
 *    attendance rows back to what the cron would compute, and leaves HR's
 *    noted overrides and days covered by another approved leave alone;
 *  - the daily cron and a reject/delete take the same advisory lock, so in
 *    either order no LEAVE row outlives a leave that is no longer approved;
 *  - so does the holiday unmark that recomputes HOLIDAY rows (it can write LEAVE),
 *    which also clears our own revert note so a later revert still applies.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { ForbiddenException } from '@nestjs/common';
import { presetPermissions, type EffectivePermissions } from '@botss/auth';
import type { Request, Response } from 'express';

import { RequestContextMiddleware, setRequestAuth } from '../common/request-context';
import { AttendanceService } from '../hr/attendance.service';
import { LEAVE_REVERT_NOTE_PREFIX } from '../hr/attendance-precedence';
import { HolidaysService } from '../hr/holidays.service';
import { LeavesService } from '../hr/leaves.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';

const ORG_A = 'cmorga000000000000000000a';
const ORG_B = 'cmorgb000000000000000000b';
const HR_A = 'cmhra0000000000000000000a';
const HR_B = 'cmhrb0000000000000000000b';
const ATTENDANCE_ONLY = 'cmattonly000000000000000a';
const EMP_A = 'cmempa00000000000000000a';
const OTHER_A = 'cmothera0000000000000000a';

const USERS: Record<string, { organizationId: string }> = {
  [HR_A]: { organizationId: ORG_A },
  [HR_B]: { organizationId: ORG_B },
  [ATTENDANCE_ONLY]: { organizationId: ORG_A },
  [EMP_A]: { organizationId: ORG_A },
  [OTHER_A]: { organizationId: ORG_A },
};

const HR_PERMS = presetPermissions({ systemRole: 'HR' });
/** Can manage users and correct attendance, but not approve leave. */
const NO_APPROVE: EffectivePermissions = {
  company: ['users.manage', 'hr.attendance'],
  workspace: [],
};

interface LeaveRow {
  id: string;
  userId: string;
  startDate: Date;
  endDate: Date;
  type: 'ANNUAL';
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string | null;
  approvedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface AttendanceRow {
  id: string;
  userId: string;
  date: Date;
  status: 'PRESENT' | 'ABSENT' | 'LEAVE' | 'HOLIDAY';
  notes: string | null;
}
type DateFilter = { gte?: Date; lte?: Date; lt?: Date };

/** Prisma hands out fresh objects; so does the fake. */
const clone = <T>(v: T): T => (v === null ? v : { ...v });
const day = (ymd: string): Date => new Date(`${ymd}T00:00:00.000Z`);
const inRange = (d: Date, f?: DateFilter): boolean =>
  !f || ((!f.gte || d >= f.gte) && (!f.lte || d <= f.lte) && (!f.lt || d < f.lt));

function leave(
  id: string,
  userId: string,
  from: string,
  to: string,
  status: LeaveRow['status'],
): LeaveRow {
  return {
    id,
    userId,
    startDate: day(from),
    endDate: day(to),
    type: 'ANNUAL',
    status,
    reason: null,
    approvedById: null,
    createdAt: day('2026-10-01'),
    updatedAt: day('2026-10-01'),
  };
}

/** In-memory Prisma covering exactly what LeavesService touches. */
function fakePrisma(init: {
  leaves: LeaveRow[];
  attendance?: AttendanceRow[];
  holidays?: { id?: string; organizationId: string; date: Date }[];
  timeEntries?: { userId: string; startTime: Date }[];
}) {
  const leaves = [...init.leaves];
  const attendance = [...(init.attendance ?? [])];
  const writes: string[] = [];
  /** Ordered log of lock / leave-read / attendance-write calls; `tx:` = inside a transaction. */
  const events: string[] = [];
  let inTx = false;
  const event = (name: string) => events.push(`${inTx ? 'tx:' : ''}${name}`);
  const userRef = (id: string) => ({ id, name: id, email: `${id}@example.test`, image: null });
  const withRefs = (l: LeaveRow) => ({
    ...l,
    user: userRef(l.userId),
    approvedBy: l.approvedById ? userRef(l.approvedById) : null,
  });
  const attendanceMatch = (
    r: AttendanceRow,
    w: {
      id?: string;
      userId?: string | { in: string[] };
      date?: DateFilter | Date;
      status?: string;
      notes?: null | { startsWith: string };
    },
  ) =>
    (w.id === undefined || r.id === w.id) &&
    (w.userId === undefined ||
      (typeof w.userId === 'string' ? r.userId === w.userId : w.userId.in.includes(r.userId))) &&
    (w.status === undefined || r.status === w.status) &&
    (!('notes' in w) ||
      (w.notes === null
        ? r.notes === null
        : (r.notes ?? '').startsWith(w.notes?.startsWith ?? ''))) &&
    (w.date instanceof Date ? r.date.getTime() === w.date.getTime() : inRange(r.date, w.date));

  const client = {
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        const u = USERS[args.where.id];
        return u ? { id: args.where.id, ...u } : null;
      },
      // The cron's staff list.
      findMany: async () => Object.entries(USERS).map(([id, u]) => ({ id, ...u })),
    },
    leave: {
      findUnique: async (args: { where: { id: string } }) =>
        clone(leaves.find((l) => l.id === args.where.id) ?? null),
      findMany: async (args: {
        where: {
          userId?: string;
          id?: { not: string };
          status?: string;
          startDate?: { lte: Date };
          endDate?: { gte: Date };
        };
      }) => {
        event('leave.findMany');
        const w = args.where;
        return leaves.filter(
          (l) =>
            (w.userId === undefined || l.userId === w.userId) &&
            (w.id === undefined || l.id !== w.id.not) &&
            (w.status === undefined || l.status === w.status) &&
            (w.startDate === undefined || l.startDate <= w.startDate.lte) &&
            (w.endDate === undefined || l.endDate >= w.endDate.gte),
        );
      },
      update: async (args: { where: { id: string }; data: Partial<LeaveRow> }) => {
        writes.push('leave.update');
        const row = leaves.find((l) => l.id === args.where.id);
        assert.ok(row, 'updated leave exists');
        Object.assign(row, args.data);
        return withRefs(row);
      },
      delete: async (args: { where: { id: string } }) => {
        writes.push('leave.delete');
        const i = leaves.findIndex((l) => l.id === args.where.id);
        const [row] = leaves.splice(i, 1);
        return row;
      },
    },
    attendance: {
      findMany: async (args: { where: Parameters<typeof attendanceMatch>[1] }) =>
        attendance.filter((r) => attendanceMatch(r, args.where)),
      updateMany: async (args: {
        where: Parameters<typeof attendanceMatch>[1];
        data: Partial<AttendanceRow>;
      }) => {
        writes.push('attendance.updateMany');
        event('attendance.updateMany');
        const hit = attendance.filter((r) => attendanceMatch(r, args.where));
        for (const r of hit) Object.assign(r, args.data);
        return { count: hit.length };
      },
      deleteMany: async (args: { where: Parameters<typeof attendanceMatch>[1] }) => {
        writes.push('attendance.deleteMany');
        event('attendance.deleteMany');
        let count = 0;
        for (let i = attendance.length - 1; i >= 0; i--) {
          if (attendanceMatch(attendance[i]!, args.where)) {
            attendance.splice(i, 1);
            count++;
          }
        }
        return { count };
      },
      createMany: async (args: {
        data: Omit<AttendanceRow, 'id' | 'notes'>[];
        skipDuplicates: boolean;
      }) => {
        writes.push('attendance.createMany');
        event('attendance.createMany');
        let count = 0;
        for (const r of args.data) {
          const dup = attendance.some(
            (a) => a.userId === r.userId && a.date.getTime() === r.date.getTime(),
          );
          if (dup) continue;
          attendance.push({ ...r, id: `gen-${r.userId}-${r.date.toISOString()}`, notes: null });
          count++;
        }
        return { count };
      },
    },
    holiday: {
      findUnique: async (args: { where: { id: string } }) =>
        (init.holidays ?? []).find((h) => h.id === args.where.id) ?? null,
      findMany: async (args: { where: { organizationId: string; date: DateFilter } }) =>
        (init.holidays ?? []).filter(
          (h) => h.organizationId === args.where.organizationId && inRange(h.date, args.where.date),
        ),
    },
    timeEntry: {
      findMany: async (args: { where: { userId: string; startTime: DateFilter } }) =>
        (init.timeEntries ?? []).filter(
          (e) => e.userId === args.where.userId && inRange(e.startTime, args.where.startTime),
        ),
      // The cron's "who logged time that day".
      groupBy: async (args: { where: { startTime: DateFilter } }) => {
        const ids = new Set(
          (init.timeEntries ?? [])
            .filter((e) => inRange(e.startTime, args.where.startTime))
            .map((e) => e.userId),
        );
        return [...ids].map((userId) => ({ userId, _count: { _all: 1 } }));
      },
    },
    $executeRaw: async (sql: { strings: string[]; values: unknown[] }) => {
      assert.match(
        sql.strings.join('?'),
        /pg_advisory_xact_lock\(hashtext\(\?\)\)/,
        'advisory lock SQL',
      );
      writes.push('lock');
      event(`lock:${String(sql.values[0])}`);
      return 1;
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      inTx = true;
      try {
        return await fn(client);
      } finally {
        inTx = false;
      }
    },
  };
  return { prisma: { client } as unknown as PrismaService, leaves, attendance, writes, events };
}

function fakeNotifications() {
  const sent: { userId: string; url?: string | null }[] = [];
  const service = {
    emit: async (args: { userId: string; url?: string | null }) => {
      sent.push(args);
    },
  } as unknown as NotificationsService;
  return { service, sent };
}

/** Run `fn` as `userId`, the way AuthGuard leaves a request. */
function as<T>(
  userId: string,
  permissions: EffectivePermissions,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new RequestContextMiddleware().use({} as Request, {} as Response, () => {
      setRequestAuth({
        userId,
        systemRole: 'HR',
        organizationId: USERS[userId]?.organizationId ?? null,
        permissions,
      });
      fn().then(resolve, reject);
    });
  });
}

const forbidden =
  (title?: string) =>
  (err: unknown): boolean => {
    if (!(err instanceof ForbiddenException)) return false;
    if (!title) return true;
    const body = err.getResponse() as { title?: string };
    return body.title === title;
  };

const LEAVE_ID = 'cmleave00000000000000000a';
const OWN_ID = 'cmleaveown000000000000000';
const OTHER_LEAVE_ID = 'cmleaveoth000000000000000';

async function main(): Promise<void> {
  // --- who may decide -------------------------------------------------------
  {
    const { prisma, writes } = fakePrisma({
      leaves: [
        leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'PENDING'),
        leave(OWN_ID, HR_A, '2026-10-09', '2026-10-09', 'PENDING'),
      ],
    });
    const notes = fakeNotifications();
    const leaves = new LeavesService(prisma, notes.service);

    await as(ATTENDANCE_ONLY, NO_APPROVE, () =>
      assert.rejects(
        leaves.updateStatus(ATTENDANCE_ONLY, LEAVE_ID, { status: 'APPROVED' }),
        forbidden('Only HR can decide leave requests'),
        'users.manage / hr.attendance cannot decide leave',
      ),
    );
    await as(HR_A, HR_PERMS, () =>
      assert.rejects(
        leaves.updateStatus(HR_A, OWN_ID, { status: 'APPROVED' }),
        forbidden("You can't decide your own leave request"),
        'HR cannot approve their own request',
      ),
    );
    await as(HR_A, HR_PERMS, () =>
      assert.rejects(
        leaves.updateStatus(HR_A, OWN_ID, { status: 'REJECTED' }),
        forbidden("You can't decide your own leave request"),
        'HR cannot reject their own request either',
      ),
    );
    await as(HR_B, HR_PERMS, () =>
      assert.rejects(
        leaves.updateStatus(HR_B, LEAVE_ID, { status: 'APPROVED' }),
        forbidden('Leave belongs to a user outside your organization'),
        'HR of another org is refused',
      ),
    );
    assert.deepEqual(writes, [], 'refused decisions write nothing');
    assert.equal(notes.sent.length, 0, 'refused decisions notify nobody');

    const approved = await as(HR_A, HR_PERMS, () =>
      leaves.updateStatus(HR_A, LEAVE_ID, { status: 'APPROVED' }),
    );
    assert.equal(approved.status, 'APPROVED', 'HR approves an employee request');
    assert.equal(approved.approvedById, HR_A, 'approver recorded');
    // emit() is fire-and-forget; let it run.
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      notes.sent.map((n) => [n.userId, n.url]),
      [[EMP_A, '/timesheets/leave']],
      'employee notified with a link to their leave page',
    );
  }

  // --- attendance after an approved leave is rejected / deleted -------------
  // 2026-10-09 is a Friday; the leave runs Fri 9 .. Wed 14.
  for (const action of ['reject', 'delete'] as const) {
    const att = (
      id: string,
      userId: string,
      ymd: string,
      notes: string | null = null,
    ): AttendanceRow => ({
      id,
      userId,
      date: day(ymd),
      status: 'LEAVE',
      notes,
    });
    const { prisma, attendance, writes } = fakePrisma({
      leaves: [
        leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-14', 'APPROVED'),
        // A second approved leave still covers Tue 13.
        leave(OTHER_LEAVE_ID, EMP_A, '2026-10-13', '2026-10-13', 'APPROVED'),
      ],
      attendance: [
        att('a-fri', EMP_A, '2026-10-09'),
        att('a-sat', EMP_A, '2026-10-10'),
        att('a-sun', EMP_A, '2026-10-11'),
        att('a-mon', EMP_A, '2026-10-12', 'Doctor note on file'),
        att('a-tue', EMP_A, '2026-10-13'),
        att('a-wed', EMP_A, '2026-10-14'),
        att('a-after', EMP_A, '2026-10-15'),
        att('a-other-user', OTHER_A, '2026-10-09'),
      ],
      holidays: [{ organizationId: ORG_A, date: day('2026-10-14') }],
      timeEntries: [{ userId: EMP_A, startTime: new Date('2026-10-11T09:30:00.000Z') }],
    });
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    await as(HR_A, HR_PERMS, () =>
      action === 'reject'
        ? leaves.updateStatus(HR_A, LEAVE_ID, { status: 'REJECTED' }).then(() => undefined)
        : leaves.remove(HR_A, LEAVE_ID).then(() => undefined),
    );
    const byId = new Map(attendance.map((r) => [r.id, r]));
    const label = `after ${action}`;
    assert.equal(writes[0], 'lock', `${label}: the attendance/leave lock is taken first`);
    assert.equal(byId.get('a-fri')?.status, 'ABSENT', `${label}: weekday without time is ABSENT`);
    assert.match(
      byId.get('a-fri')?.notes ?? '',
      /^Was LEAVE until the leave request was/,
      `${label}: note explains it`,
    );
    assert.equal(
      byId.has('a-sat'),
      false,
      `${label}: idle weekend row removed (the cron writes none)`,
    );
    assert.equal(byId.get('a-sun')?.status, 'PRESENT', `${label}: day with logged time is PRESENT`);
    assert.equal(byId.get('a-mon')?.status, 'LEAVE', `${label}: HR override with a note untouched`);
    assert.equal(byId.get('a-mon')?.notes, 'Doctor note on file', `${label}: override note kept`);
    assert.equal(
      byId.get('a-tue')?.status,
      'LEAVE',
      `${label}: day under another approved leave stays LEAVE`,
    );
    assert.equal(byId.get('a-wed')?.status, 'HOLIDAY', `${label}: holiday wins`);
    assert.equal(
      byId.get('a-after')?.status,
      'LEAVE',
      `${label}: rows outside the range untouched`,
    );
    assert.equal(byId.get('a-other-user')?.status, 'LEAVE', `${label}: other people untouched`);
  }

  // Rejecting a request that was never approved touches no attendance.
  {
    const { prisma, writes } = fakePrisma({
      leaves: [leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'PENDING')],
      attendance: [
        { id: 'a', userId: EMP_A, date: day('2026-10-09'), status: 'LEAVE', notes: null },
      ],
    });
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    await as(HR_A, HR_PERMS, () => leaves.updateStatus(HR_A, LEAVE_ID, { status: 'REJECTED' }));
    assert.deepEqual(writes, ['lock', 'leave.update'], 'pending -> rejected writes only the leave');
  }

  // An employee's cancel races HR's approval: the first read still says
  // PENDING, the locked re-read says APPROVED. The cancel must be refused.
  {
    const {
      prisma,
      leaves: rows,
      writes,
    } = fakePrisma({
      leaves: [leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'PENDING')],
      attendance: [
        { id: 'a', userId: EMP_A, date: day('2026-10-09'), status: 'LEAVE', notes: null },
      ],
    });
    const leaveModel = (
      prisma as unknown as {
        client: {
          leave: { findUnique: (args: { where: { id: string } }) => Promise<LeaveRow | null> };
        };
      }
    ).client.leave;
    const read = leaveModel.findUnique;
    let reads = 0;
    leaveModel.findUnique = async (args) => {
      const row = await read(args);
      // HR approves right after the employee's first (unlocked) read.
      if (++reads === 1) rows[0]!.status = 'APPROVED';
      return row;
    };
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    await as(EMP_A, presetPermissions({ systemRole: 'EMPLOYEE' }), () =>
      assert.rejects(
        leaves.remove(EMP_A, LEAVE_ID),
        forbidden('Cannot delete a processed leave request.'),
        'employee cannot cancel a request approved since their first read',
      ),
    );
    assert.equal(reads, 2, 'the status was re-read under the lock');
    assert.deepEqual(writes, ['lock'], 'refused cancel deletes nothing and reverts nothing');
    assert.equal(rows.length, 1, 'the approved leave still exists');
  }

  // --- holiday unmark (recompute branch) is a LEAVE writer too ---------------
  // Fri 9 Oct was stamped HOLIDAY and is covered by an approved leave. Unmark
  // recomputes it under the lock; in either order with a reject, no LEAVE row
  // outlives the leave.
  for (const order of ['unmark-then-reject', 'reject-then-unmark'] as const) {
    const HOLIDAY_ID = 'cmholiday0000000000000000';
    const { prisma, attendance, events } = fakePrisma({
      leaves: [leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'APPROVED')],
      attendance: [
        { id: 'h', userId: EMP_A, date: day('2026-10-09'), status: 'HOLIDAY', notes: null },
      ],
      // Unmark keeps the holiday definition.
      holidays: [{ id: HOLIDAY_ID, organizationId: ORG_A, date: day('2026-10-09') }],
    });
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    const admin = { assertAdminOrHR: async () => undefined } as never;
    const holidays = new HolidaysService(prisma, admin, leaves);
    const unmark = () => as(HR_A, HR_PERMS, () => holidays.unmark(HR_A, HOLIDAY_ID));
    const reject = () =>
      as(HR_A, HR_PERMS, () => leaves.updateStatus(HR_A, LEAVE_ID, { status: 'REJECTED' }));
    if (order === 'unmark-then-reject') {
      await unmark();
      assert.deepEqual(
        events,
        [
          'tx:lock:attendance-leave',
          'tx:leave.findMany',
          'tx:attendance.updateMany',
          'tx:attendance.updateMany',
        ],
        'unmark takes the lock before reading leaves and writing rows, in one transaction',
      );
      assert.equal(attendance[0]?.status, 'LEAVE', 'unmark recomputes HOLIDAY -> LEAVE');
      await reject();
    } else {
      await reject();
      await unmark();
    }
    // unmark-then-reject: the revert recomputes with the holiday definition
    // still there -> HOLIDAY. reject-then-unmark: no approved leave -> ABSENT.
    assert.equal(
      attendance[0]?.status,
      order === 'unmark-then-reject' ? 'HOLIDAY' : 'ABSENT',
      `${order}: no LEAVE row survives the reject`,
    );
  }

  // A HOLIDAY row still carrying our revert note (L1 rejected, then the day
  // marked as a holiday, which keeps notes) is recomputed to LEAVE for an
  // approved L2: the note is cleared, so rejecting L2 still reverts it. An
  // HR-written note is kept (that row is then HR's, and stays LEAVE).
  {
    const HOLIDAY_ID = 'cmholiday0000000000000000';
    const revertNote = `${LEAVE_REVERT_NOTE_PREFIX} the leave request was rejected on 2026-10-10.`;
    const { prisma, attendance } = fakePrisma({
      leaves: [
        leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'APPROVED'),
        leave(OTHER_LEAVE_ID, OTHER_A, '2026-10-09', '2026-10-09', 'APPROVED'),
      ],
      attendance: [
        { id: 'sys', userId: EMP_A, date: day('2026-10-09'), status: 'HOLIDAY', notes: revertNote },
        {
          id: 'hr',
          userId: OTHER_A,
          date: day('2026-10-09'),
          status: 'HOLIDAY',
          notes: 'Approved by phone',
        },
      ],
      holidays: [{ id: HOLIDAY_ID, organizationId: ORG_A, date: day('2026-10-09') }],
    });
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    const holidays = new HolidaysService(
      prisma,
      { assertAdminOrHR: async () => undefined } as never,
      leaves,
    );
    await as(HR_A, HR_PERMS, () => holidays.unmark(HR_A, HOLIDAY_ID));
    const byId = () => new Map(attendance.map((r) => [r.id, r]));
    assert.deepEqual(
      [byId().get('sys')?.status, byId().get('sys')?.notes],
      ['LEAVE', null],
      'recompute to LEAVE clears our own revert note',
    );
    assert.deepEqual(
      [byId().get('hr')?.status, byId().get('hr')?.notes],
      ['LEAVE', 'Approved by phone'],
      'recompute to LEAVE keeps an HR-written note',
    );
    await as(HR_A, HR_PERMS, () => leaves.updateStatus(HR_A, LEAVE_ID, { status: 'REJECTED' }));
    // The holiday still stands, so the reverted row is HOLIDAY again, with a fresh revert note.
    assert.equal(byId().get('sys')?.status, 'HOLIDAY', 'rejecting L2 reverts the recomputed row');
    assert.ok(
      byId().get('sys')?.notes?.startsWith(LEAVE_REVERT_NOTE_PREFIX),
      'revert note written',
    );
  }

  // --- the cron and a reject/delete are serialized by one advisory lock -----
  // The lock makes the two run one after the other; either order must end
  // with no LEAVE row for a leave that is no longer approved.
  for (const order of ['cron-then-reject', 'reject-then-cron'] as const) {
    const { prisma, attendance, events } = fakePrisma({
      leaves: [leave(LEAVE_ID, EMP_A, '2026-10-09', '2026-10-09', 'APPROVED')],
    });
    const leaves = new LeavesService(prisma, fakeNotifications().service);
    const cron = new AttendanceService(prisma, {} as never, leaves);
    const runCron = () => cron.generateForDate(day('2026-10-09'));
    const reject = () =>
      as(HR_A, HR_PERMS, () => leaves.updateStatus(HR_A, LEAVE_ID, { status: 'REJECTED' }));
    if (order === 'cron-then-reject') {
      await runCron();
      assert.deepEqual(
        events,
        ['tx:lock:attendance-leave', 'tx:leave.findMany', 'tx:attendance.createMany'],
        'cron takes the lock before reading leaves and writing rows, in one transaction',
      );
      await reject();
    } else {
      await reject();
      await runCron();
    }
    assert.ok(
      events.filter((e) => e === 'tx:lock:attendance-leave').length === 2,
      `${order}: the reject also takes the lock inside its transaction`,
    );
    const emp = attendance.find((r) => r.userId === EMP_A);
    assert.equal(emp?.status, 'ABSENT', `${order}: no LEAVE row survives the reject`);
  }

  process.stdout.write('check-leaves: all checks passed\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
