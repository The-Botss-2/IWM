import { Prisma } from '@botss/database';
import type { AttendanceStatus } from '@botss/shared-types';

import type { PrismaService } from '../prisma/prisma.service';

/** An interactive-transaction client of the soft-delete-extended Prisma. */
export type AttendanceTx = Parameters<Parameters<PrismaService['client']['$transaction']>[0]>[0];

/** Advisory-lock key shared by the cron and the leave revert. */
const ATTENDANCE_LEAVE_LOCK = 'attendance-leave';

/**
 * Start of the note LeavesService writes on an attendance row it reverted
 * from LEAVE. A system note, not HR's: the holiday recompute clears it when
 * it sets the row back to LEAVE, so a later revert still recognizes the row.
 */
export const LEAVE_REVERT_NOTE_PREFIX = 'Was LEAVE until';

/** Timeout for a transaction that may wait on the attendance/leave lock. */
export const ATTENDANCE_LOCK_TX_TIMEOUT_MS = 30_000;

/**
 * Serialize every "read approved leaves -> write LEAVE rows" path against
 * "leave stops being approved -> revert its LEAVE rows". Without it a writer
 * can read a leave as APPROVED, the reject commit and find no row yet, and
 * the writer then leave a LEAVE row nobody re-checks.
 *
 * Holders - any new code that derives LEAVE from approved leaves must join:
 *  - AttendanceService.generateForDate (the daily cron);
 *  - HolidaysService.revertAttendanceForDate, recompute branch (holiday
 *    unmark without an explicit status);
 *  - LeavesService.updateStatus and .remove (decisions, deletes, and the
 *    LEAVE-row revert they trigger).
 * Not holders, because they never read leaves: HolidaysService's explicit
 * unmark statuses (including "set all to LEAVE" and the CLEAR a holiday
 * delete uses), its mark-as-holiday pass, and HR's manual override.
 *
 * One global transaction-scoped key: every holder keeps it only for a few
 * short queries, and a single key cannot deadlock. Call it first in the
 * transaction.
 */
export async function lockAttendanceLeaveWrites(
  tx: Pick<AttendanceTx, '$executeRaw'>,
): Promise<void> {
  // pg_advisory_xact_lock returns void, which $queryRaw cannot deserialize.
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${ATTENDANCE_LEAVE_LOCK}))`,
  );
}

/**
 * The status the daily attendance cron derives for one user on one day.
 * `null` means the cron writes no row (a weekend with no activity).
 *
 * Precedence: a company holiday beats an approved leave (it must not burn
 * the user's balance), a leave beats logged time, logged time beats the
 * weekday default of ABSENT.
 */
export function derivedAttendanceStatus(day: {
  onHoliday: boolean;
  onLeave: boolean;
  worked: boolean;
  isWeekend: boolean;
}): AttendanceStatus | null {
  if (day.onHoliday) return 'HOLIDAY';
  if (day.onLeave) return 'LEAVE';
  if (day.worked) return 'PRESENT';
  if (!day.isWeekend) return 'ABSENT';
  return null;
}

/** Saturday or Sunday, on the UTC calendar the attendance rows use. */
export function isUtcWeekend(day: Date): boolean {
  const dow = day.getUTCDay(); // 0 = Sun, 6 = Sat
  return dow === 0 || dow === 6;
}
