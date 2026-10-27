'use client';

import { ChevronLeft, ChevronRight, Clock, FileText, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CalendarEvent, CalendarEventType } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { useCalendarEvents } from '@/hooks/use-calendar-events';
import { useUpdateTodo } from '@/hooks/use-todos';
import { absoluteTime } from '@/lib/time';
import { cn } from '@/lib/utils';

export type CalendarViewMode = 'month' | 'week';

const ALL_TYPES: CalendarEventType[] = ['task', 'todo', 'time'];

interface Props {
  initialDate?: Date;
}

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
function endOfWeek(d: Date): Date {
  const x = startOfWeek(d);
  x.setDate(x.getDate() + 7);
  x.setMilliseconds(-1);
  return x;
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
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
function fmtMonthLabel(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function fmtWeekLabel(d: Date): string {
  const start = startOfWeek(d);
  const end = addDays(start, 6);
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

const TYPE_LABEL: Record<CalendarEventType, string> = {
  task: 'Tasks',
  todo: 'Todos',
  time: 'Time',
};
const TYPE_ICON: Record<CalendarEventType, typeof ListChecks> = {
  task: ListChecks,
  todo: FileText,
  time: Clock,
};
const TYPE_DEFAULT_COLOR: Record<CalendarEventType, string> = {
  task: '#6366f1',
  todo: '#f59e0b',
  time: '#0d9488',
};

export function GlobalCalendarView({ initialDate }: Props) {
  const [cursor, setCursor] = useState<Date>(initialDate ?? new Date());
  const [view, setView] = useState<CalendarViewMode>('month');
  const [types, setTypes] = useState<Set<CalendarEventType>>(
    () => new Set(ALL_TYPES),
  );
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  const range = useMemo(() => {
    if (view === 'month') {
      return { from: startOfMonth(cursor), to: endOfMonth(cursor) };
    }
    return { from: startOfWeek(cursor), to: endOfWeek(cursor) };
  }, [cursor, view]);

  const query = useCalendarEvents({
    from: range.from,
    to: range.to,
    types: Array.from(types),
  });
  const updateTodo = useUpdateTodo();
  const events = query.data?.items ?? [];

  function toggleType(t: CalendarEventType): void {
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-white px-4 py-3">
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous"
            onClick={() =>
              setCursor((d) => (view === 'month' ? addMonths(d, -1) : addDays(d, -7)))
            }
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCursor(new Date())}>
            Today
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next"
            onClick={() =>
              setCursor((d) => (view === 'month' ? addMonths(d, 1) : addDays(d, 7)))
            }
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="ml-2 text-sm font-semibold text-ink">
            {view === 'month' ? fmtMonthLabel(cursor) : fmtWeekLabel(cursor)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-line bg-white p-0.5 text-xs">
            {(['month', 'week'] as const).map((m) => (
              <button
                key={m}
                id={`cal-view-${m}`}
                type="button"
                onClick={() => setView(m)}
                className={cn(
                  'rounded px-2.5 py-1 capitalize transition-colors',
                  view === m
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {ALL_TYPES.map((t) => {
              const Icon = TYPE_ICON[t];
              const active = types.has(t);
              return (
                <button
                  key={t}
                  id={`cal-filter-${t}`}
                  type="button"
                  onClick={() => toggleType(t)}
                  aria-pressed={active}
                  className={cn(
                    'whitespace-nowrap inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition',
                    active
                      ? 'border-transparent text-white'
                      : 'border-line bg-white text-ink-muted',
                  )}
                  style={
                    active
                      ? { backgroundColor: TYPE_DEFAULT_COLOR[t] }
                      : undefined
                  }
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto bg-bg-subtle">
        {view === 'month' ? (
          <MonthGrid
            cursor={cursor}
            events={events}
            onSelect={setSelectedEvent}
            onTodoToggle={(id, done) =>
              updateTodo.mutate({ id, input: { done } })
            }
          />
        ) : (
          <WeekGrid
            cursor={cursor}
            events={events}
            onSelect={setSelectedEvent}
            onTodoToggle={(id, done) =>
              updateTodo.mutate({ id, input: { done } })
            }
          />
        )}
      </div>

      {selectedEvent ? (
        <EventDetailModal
          event={selectedEvent}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </div>
  );
}

function MonthGrid({
  cursor,
  events,
  onSelect,
  onTodoToggle,
}: {
  cursor: Date;
  events: CalendarEvent[];
  onSelect: (e: CalendarEvent) => void;
  onTodoToggle: (todoId: string, done: boolean) => void;
}) {
  const monthStart = startOfMonth(cursor);
  const gridStart = startOfWeek(monthStart);
  const cells = useMemo(
    () => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)),
    [gridStart],
  );
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const k = e.start.toDateString();
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return map;
  }, [events]);

  const today = new Date();

  return (
    <div className="p-3">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div
            key={d}
            className="bg-bg-subtle px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
          >
            {d}
          </div>
        ))}
        {cells.map((day) => {
          const inMonth = day.getMonth() === cursor.getMonth();
          const isToday = sameDay(day, today);
          const list = eventsByDay.get(day.toDateString()) ?? [];
          return (
            <div
              key={day.toDateString()}
              className={cn(
                'min-h-[110px] bg-white p-1.5',
                inMonth ? '' : 'bg-bg-subtle/60 text-ink-disabled',
              )}
            >
              <div className="mb-1 flex items-baseline justify-between">
                <span
                  className={cn(
                    'inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]',
                    isToday
                      ? 'bg-brand-600 font-semibold text-white'
                      : 'text-ink',
                  )}
                >
                  {day.getDate()}
                </span>
              </div>
              <ul className="space-y-0.5" role="list">
                {list.slice(0, 4).map((e) => (
                  <EventChip
                    key={e.id}
                    event={e}
                    onClick={() => onSelect(e)}
                    onTodoToggle={onTodoToggle}
                  />
                ))}
                {list.length > 4 ? (
                  <li className="text-[10px] text-ink-muted">
                    +{list.length - 4} more
                  </li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({
  cursor,
  events,
  onSelect,
  onTodoToggle,
}: {
  cursor: Date;
  events: CalendarEvent[];
  onSelect: (e: CalendarEvent) => void;
  onTodoToggle: (todoId: string, done: boolean) => void;
}) {
  const weekStart = startOfWeek(cursor);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const k = e.start.toDateString();
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    return map;
  }, [events]);
  const today = new Date();
  return (
    <div className="grid grid-cols-7 gap-px bg-line p-3">
      {days.map((d) => {
        const list = eventsByDay.get(d.toDateString()) ?? [];
        const isToday = sameDay(d, today);
        return (
          <div key={d.toDateString()} className="min-h-[400px] bg-white p-2">
            <div className="mb-2 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold',
                  isToday
                    ? 'bg-brand-600 text-white'
                    : 'text-ink',
                )}
              >
                {d.getDate()}
              </div>
            </div>
            <ul className="space-y-1" role="list">
              {list.map((e) => (
                <EventChip
                  key={e.id}
                  event={e}
                  expanded
                  onClick={() => onSelect(e)}
                  onTodoToggle={onTodoToggle}
                />
              ))}
              {list.length === 0 ? (
                <li className="text-[11px] text-ink-disabled">No events</li>
              ) : null}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function EventChip({
  event,
  expanded,
  onClick,
  onTodoToggle,
}: {
  event: CalendarEvent;
  expanded?: boolean;
  onClick: () => void;
  onTodoToggle: (todoId: string, done: boolean) => void;
}) {
  const color = event.color ?? TYPE_DEFAULT_COLOR[event.type];
  if (event.type === 'todo') {
    const done = (event.meta as { done?: boolean }).done === true;
    const todoId = (event.meta as { todoId?: string }).todoId ?? '';
    return (
      <li className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-bg-subtle">
        <input
          type="checkbox"
          checked={done}
          onChange={(e) => onTodoToggle(todoId, e.target.checked)}
          aria-label={done ? 'Mark not done' : 'Mark done'}
          className="h-3 w-3 accent-amber-500"
        />
        <button
          type="button"
          onClick={onClick}
          className={cn(
            'min-w-0 flex-1 truncate text-left',
            done ? 'text-ink-disabled line-through' : 'text-ink',
          )}
          style={{ color: done ? undefined : color }}
        >
          {event.title}
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:opacity-80',
          expanded ? 'truncate' : 'truncate',
        )}
        style={{ backgroundColor: `${color}22`, color }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="truncate font-medium">{event.title}</span>
      </button>
    </li>
  );
}

function EventDetailModal({
  event,
  onClose,
}: {
  event: CalendarEvent;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label="Event details"
      className="fixed inset-0 z-40 grid place-items-center bg-ink/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-[min(420px,90vw)] rounded-lg border border-line bg-white p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">{event.title}</h2>
          <span className="whitespace-nowrap rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
            {event.type}
          </span>
        </div>
        <div className="space-y-2 text-sm text-ink">
          <div className="text-xs text-ink-muted">
            {absoluteTime(event.start)}
            {event.end ? ` → ${absoluteTime(event.end)}` : ''}
          </div>
          {event.projectName ? (
            <div className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: event.color ?? '#94a3b8' }}
                aria-hidden
              />
              <span>{event.projectName}</span>
            </div>
          ) : null}
          {event.type === 'task' ? (
            <dl className="grid grid-cols-2 gap-1 text-xs text-ink-muted">
              {Object.entries(event.meta).map(([k, v]) =>
                k === 'taskId' ? null : (
                  <div key={k} className="contents">
                    <dt className="uppercase tracking-wide text-ink-disabled">{k}</dt>
                    <dd className="text-ink">{String(v ?? '-')}</dd>
                  </div>
                ),
              )}
            </dl>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {event.type === 'task' && event.projectId ? (
            <Link
              href={`/projects/${event.projectId}`}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-bg-subtle"
            >
              Open project
            </Link>
          ) : null}
          {event.type === 'todo' ? (
            <Link
              href="/todo"
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-bg-subtle"
            >
              Open todos
            </Link>
          ) : null}
          {event.type === 'time' ? (
            <Link
              href="/timesheets"
              className="rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink hover:bg-bg-subtle"
            >
              Open timesheets
            </Link>
          ) : null}
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
