import type { TaskWithPeople } from '@botss/shared-types';

/** Due-date quick filters shared by the project task toolbar and the dashboard. */
export type DueDatePreset =
  | 'all'
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'this_week'
  | 'next_14_days'
  | 'no_date';

export const DUE_DATE_PRESETS: readonly DueDatePreset[] = [
  'all',
  'overdue',
  'today',
  'tomorrow',
  'this_week',
  'next_14_days',
  'no_date',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a task's due date falls in the preset's window (local-time days).
 * `overdue` additionally excludes DONE / CANCELLED tasks.
 */
export function matchesDuePreset(
  t: Pick<TaskWithPeople, 'dueDate' | 'status'>,
  preset: DueDatePreset,
  now: Date = new Date(),
): boolean {
  if (preset === 'all') return true;
  if (preset === 'no_date') return !t.dueDate;
  if (!t.dueDate) return false;

  const dueTime = new Date(t.dueDate).getTime();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayEnd = todayStart + DAY_MS - 1;
  const tomorrowEnd = todayEnd + DAY_MS;
  const weekEnd = todayStart + 7 * DAY_MS;
  const next14Days = todayStart + 14 * DAY_MS;

  switch (preset) {
    case 'overdue':
      return dueTime < todayStart && t.status !== 'DONE' && t.status !== 'CANCELLED';
    case 'today':
      return dueTime >= todayStart && dueTime <= todayEnd;
    case 'tomorrow':
      return dueTime > todayEnd && dueTime <= tomorrowEnd;
    case 'this_week':
      return dueTime >= todayStart && dueTime <= weekEnd;
    case 'next_14_days':
      return dueTime >= todayStart && dueTime <= next14Days;
  }
}
