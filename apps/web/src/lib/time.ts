import { formatDistanceToNowStrict, format, isValid } from 'date-fns';

export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (!isValid(d)) return '';
  return formatDistanceToNowStrict(d, { addSuffix: true });
}

export function absoluteTime(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (!isValid(d)) return '';
  return format(d, 'PPpp');
}

export function isOverdue(due: Date | string | null | undefined): boolean {
  if (!due) return false;
  const d = typeof due === 'string' ? new Date(due) : due;
  if (!isValid(d)) return false;
  return d.getTime() < Date.now();
}
