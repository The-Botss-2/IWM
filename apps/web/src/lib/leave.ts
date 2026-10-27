import type { LeaveStatus, LeaveType } from '@botss/shared-types';

/**
 * Leave dates are whole days stored as UTC midnight (the server runs
 * `startOfDay` in UTC, and attendance rows use the same calendar). A date
 * picked in the browser is local midnight, which in PKT / GST is the
 * previous UTC day - so build the UTC midnight from the local Y-M-D instead
 * of sending the picked `Date` as is.
 */
export function toUtcDay(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

/** Local calendar day of a picked date, as `YYYY-MM-DD`. */
function localYmd(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The UTC-midnight day the user picked in a local date picker. */
export function pickedDayToUtc(d: Date): Date {
  return toUtcDay(localYmd(d));
}

/** Inclusive number of calendar days a leave covers. */
export function leaveDayCount(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Format a stored UTC-midnight day without the viewer's offset moving it. */
function formatUtcDay(d: Date, withYear: boolean): string {
  return d.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** "Oct 9 – Oct 14, 2026", or a single day when start and end match. */
export function formatLeaveRange(start: Date, end: Date): string {
  if (start.getTime() === end.getTime()) return formatUtcDay(start, true);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${formatUtcDay(start, !sameYear)} – ${formatUtcDay(end, true)}`;
}

export const LEAVE_TYPE_LABELS: Record<LeaveType, string> = {
  ANNUAL: 'Annual',
  CASUAL: 'Casual',
  SICK: 'Sick',
  UNPAID: 'Unpaid',
};

export const LEAVE_STATUS_LABELS: Record<LeaveStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};
