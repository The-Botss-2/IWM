'use client';

import {
  CalendarPlus,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Eraser,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { AttendanceStatus, Holiday } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  type ContextMenuItem,
} from '@/components/ui/context-menu';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { Textarea } from '@/components/ui/textarea';
import { UserAvatar } from '@/components/ui/avatar';
import {
  useAttendanceMatrix,
  useOverrideAttendance,
} from '@/hooks/use-attendance';
import {
  useApplyHoliday,
  useCreateHoliday,
  useDeleteHoliday,
  useHolidays,
  useUnmarkHoliday,
} from '@/hooks/use-holidays';
import { toast, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { HolidayDetails } from '@/components/admin/holiday-details';

/**
 * Cross-user attendance grid for HR / Admin. Rows are users, columns
 * are the days of the selected month. Click any cell to override the
 * recorded status (with a free-text note that lands in `Attendance.notes`).
 *
 * The dataset comes from `/attendance/matrix` which is server-side gated
 * to ADMIN / HR. The page is also wrapped by the `/admin` layout guard
 * so non-privileged users bounce to `/home` before any data fetch.
 */
export default function AdminAttendancePage() {
  const [monthCursor, setMonthCursor] = useState<Date>(
    () => startOfMonth(new Date()),
  );
  const range = useMemo(() => {
    const from = startOfMonth(monthCursor);
    const to = endOfMonth(monthCursor);
    return { from, to };
  }, [monthCursor]);
  const { data, isLoading, isError, refetch } = useAttendanceMatrix(range);
  const dayCount = data ? data.dateRange.length : 0;
  const [search, setSearch] = useState('');
  // Client-side member filter over the already-loaded matrix - no extra
  // fetch, just narrows the visible rows by name.
  const filteredRows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.user.name.toLowerCase().includes(q));
  }, [data, search]);
  const [editing, setEditing] = useState<{
    userId: string;
    name: string;
    date: string;
    current: AttendanceStatus | null;
  } | null>(null);

  const monthLabel = monthCursor.toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Attendance</h2>
          <p className="text-sm text-ink-muted">
            Monthly status grid. Click any cell to override.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Previous month"
            onClick={() =>
              setMonthCursor((d) => addMonths(startOfMonth(d), -1))
            }
            className="h-9 w-9 min-h-0 min-w-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[130px] text-center text-sm font-medium text-ink">
            {monthLabel}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Next month"
            onClick={() =>
              setMonthCursor((d) => addMonths(startOfMonth(d), 1))
            }
            className="h-9 w-9 min-h-0 min-w-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setMonthCursor(startOfMonth(new Date()))}
          >
            This month
          </Button>
          <Button asChild variant="secondary">
            <Link href="/admin/leaves">
              <CalendarRange className="h-4 w-4" />
              Leave requests
            </Link>
          </Button>
        </div>
      </header>

      <Legend />

      <HolidaysPanel range={range} />

      <div className="relative max-w-xs">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search members…"
          aria-label="Search members"
          className="input h-9 w-full pl-8 text-sm"
        />
      </div>

      <div className="overflow-x-auto rounded-xl bg-white shadow-soft">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-line bg-bg-subtle text-ink-muted">
              <th className="sticky left-0 z-10 min-w-[200px] bg-bg-subtle px-3 py-2 text-left font-medium">
                Member
              </th>
              {(data?.dateRange ?? []).map((d) => (
                <th
                  key={d}
                  className="w-7 px-1 py-2 text-center font-medium"
                  scope="col"
                  title={d}
                >
                  {d.slice(-2)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td
                  colSpan={dayCount + 1}
                  className="px-3 py-12 text-center"
                >
                  <Loader size="sm" label="Loading attendance" />
                </td>
              </tr>
            ) : isError && !data ? (
              <tr>
                <td colSpan={dayCount + 1} className="px-3 py-6">
                  <QueryError
                    message="Couldn't load attendance."
                    onRetry={() => void refetch()}
                  />
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td
                  colSpan={dayCount + 1}
                  className="px-3 py-12 text-center text-ink-muted"
                >
                  {search.trim()
                    ? 'No members match that search.'
                    : 'No users to display.'}
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <tr key={row.user.id} className="border-b border-line hover:bg-bg-subtle/40">
                  <td className="sticky left-0 z-10 bg-white px-3 py-2">
                    <div className="flex items-center gap-2">
                      <UserAvatar size="xs" name={row.user.name} image={row.user.image} />
                      <span className="truncate text-ink">{row.user.name}</span>
                    </div>
                  </td>
                  {row.cells.map((cell) => (
                    <td key={cell.date} className="px-0.5 py-1 text-center">
                      <button
                        type="button"
                        title={`${row.user.name} · ${cell.date}: ${cell.status ?? '-'}`}
                        onClick={() =>
                          setEditing({
                            userId: row.user.id,
                            name: row.user.name,
                            date: cell.date,
                            current: cell.status,
                          })
                        }
                        className={cn(
                          'inline-block h-6 w-6 rounded-md border border-transparent',
                          'transition hover:border-ink/30 focus-visible:outline-none focus-visible:shadow-focus',
                          cellTone(cell.status),
                        )}
                      >
                        <span className="sr-only">{cell.status ?? 'No record'}</span>
                      </button>
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {editing ? (
        <OverrideDialog
          userId={editing.userId}
          name={editing.name}
          date={editing.date}
          current={editing.current}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
      <LegendKey color="bg-brand-teal" label="Present" />
      <LegendKey color="bg-state-error" label="Absent" />
      <LegendKey color="bg-brand-orange" label="Leave" />
      <LegendKey color="bg-brand-purple" label="Holiday" />
      <LegendKey color="bg-bg-subtle border border-line" label="No record" />
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className={cn('h-3 w-3 rounded-sm', color)} />
      {label}
    </span>
  );
}

function cellTone(status: AttendanceStatus | null): string {
  switch (status) {
    case 'PRESENT':
      return 'bg-brand-teal text-white';
    case 'ABSENT':
      return 'bg-state-error text-white';
    case 'LEAVE':
      return 'bg-brand-orange text-white';
    case 'HOLIDAY':
      return 'bg-brand-purple text-white';
    default:
      return 'bg-bg-subtle';
  }
}

function OverrideDialog({
  userId,
  name,
  date,
  current,
  onClose,
}: {
  userId: string;
  name: string;
  date: string;
  current: AttendanceStatus | null;
  onClose: () => void;
}) {
  const override = useOverrideAttendance();
  const [status, setStatus] = useState<AttendanceStatus>(current ?? 'PRESENT');
  const [notes, setNotes] = useState('');

  return (
    <div
      role="dialog"
      aria-label="Override attendance"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-soft-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold text-ink">Override attendance</h3>
            <p className="text-xs text-ink-muted">
              {name} · {date}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
            className="h-8 w-8 min-h-0 min-w-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="override-status">Status</Label>
            <div
              id="override-status"
              role="radiogroup"
              className="flex flex-wrap gap-2"
            >
              {(['PRESENT', 'ABSENT', 'LEAVE', 'HOLIDAY'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={status === s}
                  onClick={() => setStatus(s)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition',
                    status === s
                      ? s === 'PRESENT'
                        ? 'bg-brand-teal text-white'
                        : s === 'ABSENT'
                          ? 'bg-state-error text-white'
                          : s === 'LEAVE'
                            ? 'bg-brand-orange text-white'
                            : 'bg-brand-purple text-white'
                      : 'bg-bg-subtle text-ink hover:bg-line',
                  )}
                >
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="override-notes">Notes (optional)</Label>
            <Textarea
              id="override-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={255}
              placeholder="Audit trail - why was this changed?"
              className="min-h-[80px]"
            />
          </div>
        </div>

        <footer className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={override.isPending}
            onClick={() => {
              override.mutate(
                {
                  userId,
                  date: new Date(`${date}T00:00:00Z`),
                  status,
                  notes: notes.trim() || undefined,
                },
                {
                  onSuccess: () => {
                    toast.success('Attendance updated.');
                    onClose();
                  },
                },
              );
            }}
          >
            Save override
          </Button>
        </footer>
      </div>
    </div>
  );
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function endOfMonth(d: Date): Date {
  // Last day of the current month, UTC midnight.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}
function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/**
 * Public-holiday manager. Lists every holiday in the current month
 * (from the matrix range) and lets HR / Admin add or remove one. Adding
 * a holiday hits POST /holidays which bulk-stamps every org member's
 * Attendance row as HOLIDAY in one transaction.
 */
function HolidaysPanel({ range }: { range: { from: Date; to: Date } }) {
  const { data, isLoading, isError, refetch } = useHolidays(range);
  const create = useCreateHoliday();
  const remove = useDeleteHoliday();
  const apply = useApplyHoliday();
  const unmark = useUnmarkHoliday();
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  // Unmark chooser: which holiday + where to anchor the popover. HR picks
  // what the stamped attendance rows become instead of silently defaulting
  // weekdays to ABSENT.
  const [unmarkMenu, setUnmarkMenu] = useState<{
    holidayId: string;
    position: { x: number; y: number };
  } | null>(null);

  const items = data?.items ?? [];

  const unmarkItems: ContextMenuItem[] = unmarkMenu
    ? [
        {
          id: 'clear',
          label: 'Clear (unmark for all)',
          icon: <Eraser className="h-3.5 w-3.5" aria-hidden />,
          onSelect: () =>
            unmark.mutate({ id: unmarkMenu.holidayId, status: 'CLEAR' }),
        },
        {
          id: 'present',
          label: 'Mark everyone Present',
          onSelect: () =>
            unmark.mutate({ id: unmarkMenu.holidayId, status: 'PRESENT' }),
        },
        {
          id: 'absent',
          label: 'Mark everyone Absent',
          onSelect: () =>
            unmark.mutate({ id: unmarkMenu.holidayId, status: 'ABSENT' }),
        },
        {
          id: 'leave',
          label: 'Mark everyone on Leave',
          onSelect: () =>
            unmark.mutate({ id: unmarkMenu.holidayId, status: 'LEAVE' }),
        },
      ]
    : [];

  function handleAdd(e: React.FormEvent): void {
    e.preventDefault();
    if (!date || !name.trim()) {
      toastErrorMessage('Pick a date and enter a name');
      return;
    }
    create.mutate(
      {
        date: new Date(`${date}T00:00:00Z`),
        name: name.trim(),
        notes: notes.trim() || undefined,
        applyToAttendance: true,
      },
      {
        onSuccess: () => {
          setDate('');
          setName('');
          setNotes('');
        },
      },
    );
  }

  return (
    <section className="rounded-xl bg-white p-4 shadow-soft">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Public holidays</h3>
          <p className="text-xs text-ink-muted">
            Mark a day off for the whole organisation. Every member&apos;s
            attendance row for that date is set to HOLIDAY immediately.
          </p>
        </div>
      </header>

      <form
        onSubmit={handleAdd}
        className="grid gap-2 rounded-lg border border-line bg-bg-subtle/40 p-3 sm:grid-cols-[140px_1fr_1fr_auto]"
      >
        <div className="space-y-1">
          <Label htmlFor="holiday-date" className="text-[11px]">
            Date
          </Label>
          <input
            id="holiday-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="input h-9 w-full text-sm"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="holiday-name" className="text-[11px]">
            Name
          </Label>
          <input
            id="holiday-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Eid al-Fitr"
            maxLength={120}
            className="input h-9 w-full text-sm"
            required
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="holiday-notes" className="text-[11px]">
            Notes (optional)
          </Label>
          <input
            id="holiday-notes"
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. observed Monday"
            maxLength={255}
            className="input h-9 w-full text-sm"
          />
        </div>
        <div className="flex items-end">
          <Button
            type="submit"
            disabled={create.isPending}
            className="h-9 gap-1.5"
          >
            <CalendarPlus className="h-4 w-4" aria-hidden />
            Add holiday
          </Button>
        </div>
      </form>

      <ul role="list" className="mt-3 divide-y divide-line">
        {isLoading ? (
          <li className="flex justify-center py-6">
            <Loader size="sm" label="Loading holidays" />
          </li>
        ) : isError && !data ? (
          <li className="py-3">
            <QueryError
              compact
              message="Couldn't load holidays."
              onRetry={() => void refetch()}
            />
          </li>
        ) : items.length === 0 ? (
          <li className="py-6 text-center text-xs text-ink-muted">
            No holidays scheduled in this month.
          </li>
        ) : (
          items.map((h: Holiday) => (
            <li
              key={h.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <HolidayDetails holiday={h} />
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(h.id)}
                  title="Re-stamp attendance for every user on this date"
                >
                  Re-apply
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={unmark.isPending}
                  onClick={(e) =>
                    setUnmarkMenu({
                      holidayId: h.id,
                      position: { x: e.clientX, y: e.clientY },
                    })
                  }
                  title="Unmark this date - choose to clear it or set everyone present / absent / on leave (keeps the holiday)"
                >
                  Unmark
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${h.name}`}
                  disabled={remove.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete the "${h.name}" holiday entry? Attendance for ${new Date(h.date).toISOString().slice(0, 10)} will be cleared (unmarked) for everyone. Use Unmark instead if you want to set a specific status.`,
                      )
                    ) {
                      remove.mutate(h.id);
                    }
                  }}
                  className="h-8 w-8 min-h-0 min-w-0 text-state-error hover:bg-tint-error"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))
        )}
      </ul>

      <ContextMenu
        position={unmarkMenu?.position ?? null}
        items={unmarkItems}
        onClose={() => setUnmarkMenu(null)}
        ariaLabel="Unmark holiday options"
      />
    </section>
  );
}
