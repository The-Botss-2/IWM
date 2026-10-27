'use client';

import { CalendarDays } from 'lucide-react';
import Link from 'next/link';
import { useMemo } from 'react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useCalendarEvents } from '@/hooks/use-calendar-events';
import { cn } from '@/lib/utils';

function startOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfMonth(d: Date): Date {
  const x = startOfMonth(d);
  x.setMonth(x.getMonth() + 1);
  x.setMilliseconds(-1);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7;
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarMiniWidget() {
  const today = useMemo(() => new Date(), []);
  const monthStart = useMemo(() => startOfMonth(today), [today]);
  const monthEnd = useMemo(() => endOfMonth(today), [today]);
  const gridStart = useMemo(() => startOfWeek(monthStart), [monthStart]);
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    [gridStart],
  );
  const { data, isLoading, isError, refetch } = useCalendarEvents({
    from: monthStart,
    to: monthEnd,
    types: ['task', 'todo'],
  });
  const eventsByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of data?.items ?? []) {
      const key = e.start.toDateString();
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [data]);

  return (
    <WidgetShell
      id="widget-calendar-mini"
      title="Calendar"
      icon={CalendarDays}
      linkHref="/calendar"
    >
      {isLoading && !data ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : isError ? (
        <QueryError compact onRetry={() => void refetch()} />
      ) : (
        <div>
          <div className="mb-2 text-xs font-semibold text-ink">
            {today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
              <div key={`${d}-${i}`} className="text-[10px] text-ink-disabled">
                {d}
              </div>
            ))}
            {cells.map((day) => {
              const inMonth = day.getMonth() === today.getMonth();
              const count = eventsByDay.get(day.toDateString()) ?? 0;
              const isToday = sameDay(day, today);
              const iso = day.toISOString().slice(0, 10);
              return (
                <Link
                  key={day.toDateString()}
                  href={`/calendar?date=${iso}`}
                  className={cn(
                    'relative aspect-square rounded text-[11px]',
                    inMonth ? 'text-ink' : 'text-line-strong',
                    isToday
                      ? 'bg-brand-600 font-semibold text-white'
                      : 'hover:bg-bg-subtle',
                  )}
                >
                  <span className="absolute left-1 top-0.5">{day.getDate()}</span>
                  {count > 0 ? (
                    <span
                      className={cn(
                        'absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full',
                        isToday ? 'bg-white' : 'bg-tint-info0',
                      )}
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
          {(data?.items.length ?? 0) === 0 ? (
            <div className="mt-3">
              <WidgetEmpty icon={CalendarDays} message="No events this month." />
            </div>
          ) : null}
        </div>
      )}
    </WidgetShell>
  );
}
