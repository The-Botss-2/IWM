'use client';

import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TimeEntryWithMeta } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { getApi } from '@/lib/api';
import { absoluteTime } from '@/lib/time';
import { cn } from '@/lib/utils';

type Range = 'day' | 'week';

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function fmtRange(start: Date, endInclusive: Date): string {
  const sameYear = start.getFullYear() === endInclusive.getFullYear();
  const sameDay =
    start.getFullYear() === endInclusive.getFullYear() &&
    start.getMonth() === endInclusive.getMonth() &&
    start.getDate() === endInclusive.getDate();
  if (sameDay) {
    return start.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${endInclusive.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })}`;
}
function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}
function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function AdminTimesheetsPage() {
  const [range, setRange] = useState<Range>('day');
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [detail, setDetail] = useState<{
    userId: string;
    userName: string;
    date: string;
  } | null>(null);

  // `from` is inclusive; `to` is the cap we pass to the API (exclusive day
  // boundary after the last visible day). The attendance endpoint expects
  // a half-open range, same as the user-facing timesheets page.
  const { from, to, endInclusive } = useMemo(() => {
    if (range === 'day') {
      const f = startOfDay(anchor);
      return { from: f, to: addDays(f, 1), endInclusive: f };
    }
    const f = startOfWeek(anchor);
    return { from: f, to: addDays(f, 7), endInclusive: addDays(f, 6) };
  }, [range, anchor]);

  const attendance = useQuery({
    queryKey: ['admin', 'timesheets', 'attendance', range, from.toISOString()],
    queryFn: () => getApi().timesheets.adminAttendance({ from, to }),
    staleTime: 30_000,
  });

  const dateRange = attendance.data?.dateRange ?? [];
  const [memberSearch, setMemberSearch] = useState('');
  // The window's rows are fully loaded, so filter members client-side by
  // name/email.
  const rows = useMemo(() => {
    const all = attendance.data?.rows ?? [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        (r.user.name ?? '').toLowerCase().includes(q) ||
        r.user.email.toLowerCase().includes(q),
    );
  }, [attendance.data, memberSearch]);

  function step(direction: -1 | 1): void {
    setAnchor((d) => addDays(d, range === 'day' ? direction : direction * 7));
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Timesheets</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Daily attendance grid + every tracked entry across the
            organization. System admin only.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="Range"
            className="inline-flex rounded-md border border-line bg-white p-0.5"
          >
            <RangeButton active={range === 'day'} onClick={() => setRange('day')}>
              Day
            </RangeButton>
            <RangeButton active={range === 'week'} onClick={() => setRange('week')}>
              Week
            </RangeButton>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label={range === 'day' ? 'Previous day' : 'Previous week'}
              onClick={() => step(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setAnchor(
                  range === 'day' ? startOfDay(new Date()) : startOfWeek(new Date()),
                )
              }
            >
              {range === 'day' ? 'Today' : 'This week'}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={range === 'day' ? 'Next day' : 'Next week'}
              onClick={() => step(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <span className="text-sm font-medium text-ink">
            {fmtRange(from, endInclusive)}
          </span>
        </div>
      </header>

      <section className="rounded-lg border border-line bg-white">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Attendance grid</h3>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
              />
              <input
                type="search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Search members…"
                aria-label="Search members"
                className="input h-8 w-48 pl-8 text-sm"
              />
            </div>
            <span className="hidden text-xs text-ink-muted sm:inline">
              Click a cell to see the entries logged that day.
            </span>
          </div>
        </header>
        <div className="overflow-x-auto">
          {attendance.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : attendance.isError && !attendance.data ? (
            <div className="p-4">
              <QueryError
                message="Couldn't load timesheets."
                onRetry={() => void attendance.refetch()}
              />
            </div>
          ) : rows.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {memberSearch.trim()
                ? 'No members match your search.'
                : 'No tracked time in this window.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2">Member</th>
                  {dateRange.map((d) => (
                    <th key={d} className="px-2 py-2 text-center">
                      {dayLabel(d)}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.user.id} className="border-t border-line">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <UserAvatar
                          size="sm"
                          name={row.user.name || row.user.email}
                          image={row.user.image}
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-ink">
                            {row.user.name || row.user.email}
                          </div>
                          <div className="truncate text-xs text-ink-muted">
                            {row.user.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    {row.days.map((cell) => {
                      const active = cell.totalMinutes > 0;
                      return (
                        <td key={cell.date} className="px-1 py-2 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setDetail({
                                userId: row.user.id,
                                userName: row.user.name || row.user.email,
                                date: cell.date,
                              })
                            }
                            disabled={!active}
                            className={cn(
                              'w-full rounded-md px-2 py-1 text-xs transition-colors',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
                              active
                                ? 'cursor-pointer font-medium text-ink hover:bg-brand-50 hover:text-brand-700'
                                : 'cursor-default text-line-strong',
                            )}
                            aria-label={
                              active
                                ? `${row.user.name}, ${cell.date}: ${fmtMinutes(cell.totalMinutes)}, click for details`
                                : undefined
                            }
                          >
                            {active ? fmtMinutes(cell.totalMinutes) : '-'}
                          </button>
                        </td>
                      );
                    })}
                    <td className="px-4 py-3 text-right text-sm font-semibold text-ink">
                      {fmtMinutes(row.totalMinutes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {detail ? (
        <DayDetailDialog
          userId={detail.userId}
          userName={detail.userName}
          date={detail.date}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </div>
  );
}

function RangeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-brand-50 text-brand-700'
          : 'text-ink-muted hover:bg-bg-subtle',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Right-side panel showing every entry a given user logged on a given day:
 * project (or free-text label), task, description, billable, start–end,
 * and duration. We fetch via the admin list endpoint scoped to userId +
 * the half-open day range.
 */
function DayDetailDialog({
  userId,
  userName,
  date,
  onClose,
}: {
  userId: string;
  userName: string;
  date: string;
  onClose: () => void;
}) {
  const from = useMemo(() => new Date(`${date}T00:00:00`), [date]);
  const to = useMemo(() => addDays(from, 1), [from]);

  const entries = useQuery({
    queryKey: ['admin', 'timesheets', 'day-detail', userId, date],
    queryFn: () =>
      getApi().timesheets.adminList({ userId, from, to }),
    staleTime: 30_000,
  });

  const items = entries.data?.items ?? [];
  const totalMin = items.reduce((acc, e) => acc + (e.durationMin ?? 0), 0);
  const headingDate = from.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div
      role="dialog"
      aria-label={`${userName} entries on ${headingDate}`}
      className="fixed inset-0 z-40 flex justify-end bg-ink/40"
      onClick={onClose}
    >
      <aside
        className="h-full w-[min(480px,95vw)] overflow-y-auto border-l border-line bg-white shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">
              {userName}
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">{headingDate}</p>
            <p className="mt-1 text-xs text-ink-muted">
              Total tracked: <span className="font-semibold text-ink">{fmtMinutes(totalMin)}</span>
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="h-7 w-7 text-ink-muted"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="divide-y divide-line">
          {entries.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : entries.isError && !entries.data ? (
            <div className="p-4">
              <QueryError
                message="Couldn't load time entries."
                onRetry={() => void entries.refetch()}
              />
            </div>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              No entries on this day.
            </p>
          ) : (
            items.map((e) => <EntryRow key={e.id} entry={e} />)
          )}
        </div>
      </aside>
    </div>
  );
}

function EntryRow({ entry }: { entry: TimeEntryWithMeta }) {
  const projectName = entry.project?.name ?? entry.projectLabel ?? null;
  const taskTitle = entry.task?.title ?? entry.taskLabel ?? null;
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {projectName ? (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.project?.color ?? '#cbd5e1' }}
                aria-hidden
              />
            ) : null}
            <span className="truncate text-sm font-medium text-ink">
              {projectName ?? 'No project'}
            </span>
            {!entry.billable ? (
              <span className="ml-1 rounded bg-bg-subtle px-1 text-[10px] text-ink-muted">
                non-billable
              </span>
            ) : null}
          </div>
          {taskTitle ? (
            <div className="mt-0.5 text-xs text-ink">{taskTitle}</div>
          ) : null}
          {entry.description ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink-muted">
              {entry.description}
            </p>
          ) : null}
          <div className="mt-1 text-[11px] text-ink-muted">
            {absoluteTime(entry.startTime)}
            {entry.endTime ? ` → ${absoluteTime(entry.endTime)}` : ' · running'}
          </div>
        </div>
        <span className="shrink-0 text-sm font-semibold text-ink">
          {entry.durationMin != null ? fmtMinutes(entry.durationMin) : '…'}
        </span>
      </div>
    </div>
  );
}
