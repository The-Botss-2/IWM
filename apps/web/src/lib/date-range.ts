/**
 * Calendar-day date ranges, kept as `yyyy-mm-dd` strings in the user's local
 * time zone (what a URL and a date picker naturally hold) and converted to UTC
 * instants only at the API boundary: the start of the `from` day and the last
 * millisecond of the `to` day, both in local time.
 */

export interface DayRange {
  /** Inclusive first day, `yyyy-mm-dd`. */
  from: string;
  /** Inclusive last day, `yyyy-mm-dd`. */
  to: string;
}

export type DateRangePresetId = 'this_week' | 'last_week' | 'this_month' | 'last_30_days';

export const DATE_RANGE_PRESETS: ReadonlyArray<{ id: DateRangePresetId; label: string }> = [
  { id: 'this_week', label: 'This week' },
  { id: 'last_week', label: 'Last week' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_30_days', label: 'Last 30 days' },
];

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local calendar day of `d` as `yyyy-mm-dd`. */
export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a `yyyy-mm-dd` day, or null when it isn't a real date. */
export function parseYmd(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = YMD.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const day = Number(m[3]);
  const d = new Date(y, mo, day);
  // Rejects 2026-02-31 and friends, which Date would roll over.
  if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== day) return null;
  return d;
}

/** A well-formed range (both ends valid, from <= to) or null. */
export function normalizeDayRange(
  from: string | null | undefined,
  to: string | null | undefined,
): DayRange | null {
  const f = parseYmd(from);
  const t = parseYmd(to);
  if (!f || !t || f.getTime() > t.getTime()) return null;
  return { from: toYmd(f), to: toYmd(t) };
}

/** Inclusive UTC instants for an API call: local start of `from`, local end of `to`. */
export function dayRangeToInstants(range: DayRange): { from: Date; to: Date } {
  const from = parseYmd(range.from);
  const toStart = parseYmd(range.to);
  if (!from || !toStart) throw new Error(`Invalid day range ${range.from}..${range.to}`);
  const to = new Date(toStart);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Number of calendar days in the range, inclusive. */
export function dayRangeLength(range: DayRange): number {
  const { from, to } = dayRangeToInstants(range);
  // Round: a DST change makes one day 23 or 25 hours long.
  return Math.round((to.getTime() + 1 - from.getTime()) / 86_400_000);
}

/** The equally long range that ends the day before `range` starts. */
export function previousDayRange(range: DayRange): DayRange {
  const len = dayRangeLength(range);
  const from = parseYmd(range.from)!;
  const prevTo = new Date(from);
  prevTo.setDate(prevTo.getDate() - 1);
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - len);
  return { from: toYmd(prevFrom), to: toYmd(prevTo) };
}

function startOfIsoWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday-anchored.
  return x;
}

export function presetDayRange(id: DateRangePresetId, now: Date = new Date()): DayRange {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (id) {
    case 'this_week': {
      const start = startOfIsoWeek(today);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case 'last_week': {
      const start = startOfIsoWeek(today);
      start.setDate(start.getDate() - 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case 'this_month': {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { from: toYmd(start), to: toYmd(end) };
    }
    case 'last_30_days': {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { from: toYmd(start), to: toYmd(today) };
    }
  }
}

/** The preset a range equals today, if any - drives the picker's highlight. */
export function matchingPreset(
  range: DayRange | null,
  now: Date = new Date(),
): DateRangePresetId | null {
  if (!range) return null;
  for (const p of DATE_RANGE_PRESETS) {
    const r = presetDayRange(p.id, now);
    if (r.from === range.from && r.to === range.to) return p.id;
  }
  return null;
}

/** Short human label: "Oct 1 – Oct 31", "Oct 5", or with years when they differ from now. */
export function formatDayRange(range: DayRange, now: Date = new Date()): string {
  const from = parseYmd(range.from)!;
  const to = parseYmd(range.to)!;
  const sameYearAsNow =
    from.getFullYear() === now.getFullYear() && to.getFullYear() === now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYearAsNow
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  const f = from.toLocaleDateString(undefined, opts);
  if (range.from === range.to) return f;
  return `${f} – ${to.toLocaleDateString(undefined, opts)}`;
}
