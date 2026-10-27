import { format, isValid } from 'date-fns';
import type { PortalPayment, PortalTask } from '@botss/shared-types';

/**
 * Display formatting for the client portal. Pure string helpers, no data
 * decisions: those live in `hooks/use-portal.ts`.
 */

/** "Sep 28, 2026", the same format the staff date pickers show. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  return isValid(d) ? format(d, 'PP') : '';
}

/** Machine-readable value for a `<time dateTime>` attribute. */
export function isoDate(value: Date): string {
  return isValid(value) ? value.toISOString() : '';
}

const plainNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** "10%" from a 2dp rate string, without padding zeros. */
export function formatPercent(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? `${plainNumber.format(n)}%` : rate;
}

/** Quantities read "1" or "2.5", not "1.00". */
export function formatQuantity(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? plainNumber.format(n) : value;
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** "One-time · Website · Jan 3, 2026", skipping whatever is missing. */
export function joinParts(parts: ReadonlyArray<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(' · ');
}

/** "Hi, Sara" from "Sara Khan". */
export function greeting(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first ? `Hi, ${first}` : 'Hi there';
}

export function tasksDoneLabel(done: number, total: number): string {
  if (total === 0) return 'No tasks yet';
  return `${done} of ${total} ${plural(total, 'task', 'tasks')} done`;
}

/** "Jan 3, 2026 to Mar 30, 2026", or whichever end is known. */
export function dateRangeLabel(start: Date | null, end: Date | null): string | null {
  if (start && end) return `${formatDate(start)} to ${formatDate(end)}`;
  if (start) return `Started ${formatDate(start)}`;
  if (end) return `Due ${formatDate(end)}`;
  return null;
}

/** "Due Mar 1, 2026 · Delivered Feb 27, 2026", or whichever is known. */
export function milestoneDateLabel(milestone: {
  dueDate: Date | null;
  deliveredAt: Date | null;
}): string {
  return joinParts([
    milestone.dueDate ? `Due ${formatDate(milestone.dueDate)}` : null,
    milestone.deliveredAt ? `Delivered ${formatDate(milestone.deliveredAt)}` : null,
  ]);
}

/** Finished work shows when it finished; open work shows when it is due. */
export function taskDateLabel(task: PortalTask): string {
  if (task.status === 'DONE' && task.completedAt) return `Done ${formatDate(task.completedAt)}`;
  if (task.dueDate) return `Due ${formatDate(task.dueDate)}`;
  return '';
}

export function documentTitle(title: string): string {
  return title.trim() || 'Untitled';
}

/**
 * A document icon is free text meant for an emoji. Show it only when it
 * looks like one; anything with letters or digits is not an icon.
 */
export function documentGlyph(icon: string | null): string | null {
  const value = icon?.trim();
  if (!value || value.length > 16 || /[A-Za-z0-9]/.test(value)) return null;
  return value;
}

/** What a payment settled: its invoice, its contract, or both. */
export function paymentAppliedTo(payment: PortalPayment): string {
  return (
    joinParts([
      payment.invoiceNumber ? `Invoice ${payment.invoiceNumber}` : null,
      payment.contractTitle,
    ]) || '-'
  );
}
