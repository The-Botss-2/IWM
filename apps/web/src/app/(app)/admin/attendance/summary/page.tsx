'use client';

import { AlertTriangle, CalendarDays, CheckCircle2, Clock, Download, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/avatar';
import { useAttendanceSummary, useAttendanceUsers } from '@/hooks/use-attendance';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

type RangePreset = 'daily' | 'weekly' | 'monthly' | 'yearly';

/**
 * Combined attendance + tracked-hours dashboard. HR / Admin pick a user
 * and a window (Daily / Weekly / Monthly / Yearly preset, or custom
 * dates) and see four headline tiles + a per-day calendar heatmap that
 * highlights anomalies. The Export CSV button hits the streaming
 * `/admin/timesheets/export` endpoint so the file lands directly in
 * the user's downloads.
 */
export default function AttendanceSummaryPage() {
  const members = useAttendanceUsers();
  const [userId, setUserId] = useState<string>('');
  const [memberSearch, setMemberSearch] = useState('');
  // Narrow the (potentially long) member dropdown by name/email as the
  // admin types - purely client-side over the already-loaded list.
  const filteredMembers = useMemo(() => {
    const all = members.data ?? [];
    const q = memberSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (u) =>
        (u.name ?? '').toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q),
    );
  }, [members.data, memberSearch]);
  const [preset, setPreset] = useState<RangePreset>('monthly');
  const [from, setFrom] = useState<string>(() =>
    isoDate(startOfPreset(new Date(), 'monthly').from),
  );
  const [to, setTo] = useState<string>(() =>
    isoDate(startOfPreset(new Date(), 'monthly').to),
  );

  const range = useMemo(
    () => ({ from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`) }),
    [from, to],
  );

  const summary = useAttendanceSummary({
    userId: userId || '',
    from: range.from,
    to: range.to,
  });

  function applyPreset(p: RangePreset) {
    setPreset(p);
    const r = startOfPreset(new Date(), p);
    setFrom(isoDate(r.from));
    setTo(isoDate(r.to));
  }

  function exportCsv() {
    if (!userId) return;
    const month = `${range.from.getUTCFullYear()}-${String(range.from.getUTCMonth() + 1).padStart(2, '0')}`;
    const url = getApi().attendance.exportMonthlyUrl(userId, month);
    // Absolute URL bound through the same axios instance so cookies go
    // along. We construct a hidden anchor and click it so the browser
    // routes through its download manager (vs `window.open` which would
    // render in a tab when the response sets `Content-Disposition`).
    const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');
    const a = document.createElement('a');
    a.href = `${base}/api/v1${url}`;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink">Attendance summary</h2>
          <p className="text-sm text-ink-muted">
            Per-user combined attendance and tracked hours.
          </p>
        </div>
        <Button
          type="button"
          onClick={exportCsv}
          disabled={!userId}
          variant="secondary"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </header>

      <section className="rounded-xl bg-white p-4 shadow-soft">
        <div className="grid gap-3 sm:grid-cols-[2fr_3fr_2fr]">
          <div className="space-y-1.5">
            <Label htmlFor="summary-user">Member</Label>
            <input
              type="search"
              value={memberSearch}
              onChange={(e) => setMemberSearch(e.target.value)}
              placeholder="Search members…"
              aria-label="Search members"
              className="mb-1.5 h-9 w-full rounded-md border border-line bg-white px-3 text-sm"
            />
            <select
              id="summary-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
            >
              <option value="">
                {members.isError && !members.data
                  ? "Couldn't load members"
                  : 'Select a member…'}
              </option>
              {filteredMembers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label>Preset</Label>
            <div className="flex flex-wrap gap-1.5">
              {(['daily', 'weekly', 'monthly', 'yearly'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs font-medium transition',
                    preset === p
                      ? 'bg-brand-gradient text-white shadow-soft'
                      : 'bg-bg-subtle text-ink hover:bg-line',
                  )}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="summary-from">From</Label>
              <input
                id="summary-from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPreset('monthly');
                }}
                className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="summary-to">To</Label>
              <input
                id="summary-to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPreset('monthly');
                }}
                className="h-10 w-full rounded-md border border-line bg-white px-3 text-sm"
              />
            </div>
          </div>
        </div>
      </section>

      {!userId ? (
        <div className="rounded-xl bg-bg-subtle p-10 text-center text-sm text-ink-muted">
          Pick a member to view their summary.
        </div>
      ) : summary.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : summary.isError && !summary.data ? (
        <QueryError
          message="Couldn't load the attendance summary."
          onRetry={() => void summary.refetch()}
        />
      ) : !summary.data ? (
        <div className="rounded-xl bg-bg-subtle p-10 text-center text-sm text-ink-muted">
          No data for this range.
        </div>
      ) : (
        <>
          <UserCard data={summary.data} />
          <MetricGrid data={summary.data} />
          <DayHeatmap data={summary.data} />
        </>
      )}
    </div>
  );
}

function UserCard({
  data,
}: {
  data: NonNullable<ReturnType<typeof useAttendanceSummary>['data']>;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white p-4 shadow-soft">
      <UserAvatar size="md" name={data.user.name} image={data.user.image} />
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink">
          {data.user.name}
        </div>
        <div className="truncate text-xs text-ink-muted">{data.user.email}</div>
      </div>
    </div>
  );
}

function MetricGrid({
  data,
}: {
  data: NonNullable<ReturnType<typeof useAttendanceSummary>['data']>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        icon={<Clock className="h-3.5 w-3.5 text-brand-purple" />}
        label="Hours tracked"
        value={fmtHours(data.totalTrackedMinutes)}
      />
      <MetricCard
        icon={<CheckCircle2 className="h-3.5 w-3.5 text-brand-teal" />}
        label="Present"
        value={String(data.daysPresent)}
        suffix="days"
      />
      <MetricCard
        icon={<XCircle className="h-3.5 w-3.5 text-state-error" />}
        label="Unexcused absences"
        value={String(data.daysAbsent)}
        suffix="days"
      />
      <MetricCard
        icon={<CalendarDays className="h-3.5 w-3.5 text-brand-orange" />}
        label="Leave allocation"
        value={String(data.daysLeave)}
        suffix="days"
      />
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  suffix,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl bg-white p-5 shadow-soft">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        {icon}
        {label}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <div className="text-3xl font-bold text-ink">{value}</div>
        {suffix ? <div className="text-xs text-ink-muted">{suffix}</div> : null}
      </div>
    </div>
  );
}

function DayHeatmap({
  data,
}: {
  data: NonNullable<ReturnType<typeof useAttendanceSummary>['data']>;
}) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-soft">
      <h3 className="mb-3 text-sm font-semibold text-ink">Daily breakdown</h3>
      <div className="flex flex-wrap gap-1.5">
        {data.days.map((d) => (
          <span
            key={d.date}
            title={`${d.date} · ${d.status ?? '-'} · ${fmtHours(d.minutes)}${
              d.anomaly === 'PRESENT_LOW_HOURS'
                ? ' · PRESENT with <4h tracked'
                : d.anomaly === 'ABSENT_HAS_HOURS'
                  ? ' · ABSENT but hours logged'
                  : ''
            }`}
            className={cn(
              'relative inline-flex h-9 w-9 items-center justify-center rounded-md text-[10px] font-semibold',
              dayTone(d.status),
              d.anomaly !== 'NONE' && 'ring-2 ring-state-error/70',
            )}
          >
            {d.date.slice(-2)}
            {d.anomaly !== 'NONE' ? (
              <AlertTriangle
                className="absolute -right-1 -top-1 h-3 w-3 text-state-error drop-shadow-sm"
                aria-hidden
              />
            ) : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function dayTone(
  status: 'PRESENT' | 'ABSENT' | 'LEAVE' | 'HOLIDAY' | null,
): string {
  switch (status) {
    case 'PRESENT':
      return 'bg-brand-teal text-white';
    case 'ABSENT':
      return 'bg-state-error text-white';
    case 'HOLIDAY':
      return 'bg-brand-purple text-white';
    case 'LEAVE':
      return 'bg-brand-orange text-white';
    default:
      return 'bg-bg-subtle text-ink-muted';
  }
}

function fmtHours(min: number): string {
  if (min < 60) return `${min}m`;
  const h = (min / 60).toFixed(1).replace(/\.0$/, '');
  return `${h}h`;
}

function isoDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfPreset(now: Date, preset: RangePreset): { from: Date; to: Date } {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  switch (preset) {
    case 'daily':
      return { from: today, to: today };
    case 'weekly': {
      const dow = (today.getUTCDay() + 6) % 7; // Monday-indexed
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - dow);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      return { from: start, to: end };
    }
    case 'monthly': {
      const start = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
      );
      const end = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0),
      );
      return { from: start, to: end };
    }
    case 'yearly': {
      const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      const end = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
      return { from: start, to: end };
    }
  }
}
