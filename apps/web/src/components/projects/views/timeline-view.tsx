'use client';

import { addDays, differenceInDays, format, max, min, startOfDay } from 'date-fns';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TaskWithPeople, UpdateTaskInput } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { statusLabel } from '@/components/tasks/task-badges';
import { useTasks, useUpdateTask } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';

/**
 * Interactive Gantt-style timeline. Rows are tasks, columns are days. A bar
 * spans startDate→dueDate; the body can be dragged to shift both dates while
 * preserving the duration, the left/right edges can be dragged to adjust the
 * start/end independently. Drag uses pointer events directly (rather than
 * @dnd-kit) because we need pixel-precise positions for the bar geometry.
 */
const MIN_DAYS = 1;
const CLICK_DRAG_THRESHOLD_PX = 4;

type ZoomMode = 'day' | 'week' | 'month';
type DragMode = 'move' | 'resize-start' | 'resize-end';

const ZOOM_PX: Record<ZoomMode, number> = {
  day: 32,
  week: 16,
  month: 8,
};

interface ActiveDrag {
  taskId: string;
  mode: DragMode;
  pointerId: number;
  startX: number;
  initialStart: Date;
  initialEnd: Date;
  // Live values updated during the drag; flushed on pointerup.
  currentStart: Date;
  currentEnd: Date;
  // Whether the pointer travelled far enough during this gesture for us to
  // treat it as a drag (not a click). Used to suppress onClick handlers when
  // a drag actually happened.
  moved: boolean;
}

export default function TimelineView({
  projectId,
  onSelectTask,
}: {
  projectId: string;
  onSelectTask?: (id: string) => void;
}) {
  const tasks = useTasks({ projectId, pageSize: 200 });
  const update = useUpdateTask();
  const [zoom, setZoom] = useState<ZoomMode>('day');
  const dayPx = ZOOM_PX[zoom];

  // Local overrides to render the bar at its in-progress location during drag
  // and immediately after drop (before the optimistic cache patch lands).
  const [overrides, setOverrides] = useState<Record<string, { start: Date; end: Date }>>({});

  const data = useMemo(() => {
    if (!tasks.data) return null;
    const dated = tasks.data.items.filter((t) => t.dueDate || t.startDate);
    const undated = tasks.data.items.length - dated.length;
    if (dated.length === 0) {
      return { range: null, byStatus: new Map<string, TaskWithPeople[]>(), undated };
    }
    let minDate = startOfDay(new Date());
    let maxDate = addDays(minDate, 14);
    for (const t of dated) {
      const s = (t.startDate ?? t.dueDate) as Date;
      const e = (t.dueDate ?? t.startDate) as Date;
      minDate = min([minDate, s]);
      maxDate = max([maxDate, e]);
    }
    minDate = addDays(startOfDay(minDate), -3);
    maxDate = addDays(startOfDay(maxDate), 7);

    const grouped = new Map<string, TaskWithPeople[]>();
    for (const t of dated) {
      const label = statusLabel(t.status);
      const arr = grouped.get(label) ?? [];
      arr.push(t);
      grouped.set(label, arr);
    }
    return { range: { minDate, maxDate }, byStatus: grouped, undated };
  }, [tasks.data]);

  const activeDragRef = useRef<ActiveDrag | null>(null);

  const finishDrag = useCallback(
    (commit: boolean) => {
      const drag = activeDragRef.current;
      if (!drag) return;
      activeDragRef.current = null;
      if (commit && drag.moved) {
        const sameStart = drag.currentStart.getTime() === drag.initialStart.getTime();
        const sameEnd = drag.currentEnd.getTime() === drag.initialEnd.getTime();
        if (!sameStart || !sameEnd) {
          const input: UpdateTaskInput = {};
          if (!sameStart) input.startDate = drag.currentStart;
          if (!sameEnd) input.dueDate = drag.currentEnd;
          update.mutate({ id: drag.taskId, input });
        }
      }
      setOverrides((prev) => {
        const next = { ...prev };
        delete next[drag.taskId];
        return next;
      });
    },
    [update],
  );

  // Global pointer move + up so the drag continues even if the cursor leaves
  // the bar. We bind once at module level rather than per-bar.
  useEffect(() => {
    function onMove(ev: PointerEvent) {
      const drag = activeDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      const deltaPx = ev.clientX - drag.startX;
      if (!drag.moved && Math.abs(deltaPx) >= CLICK_DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
      const deltaDays = Math.round(deltaPx / dayPx);
      let nextStart = drag.initialStart;
      let nextEnd = drag.initialEnd;
      if (drag.mode === 'move') {
        nextStart = addDays(drag.initialStart, deltaDays);
        nextEnd = addDays(drag.initialEnd, deltaDays);
      } else if (drag.mode === 'resize-start') {
        nextStart = addDays(drag.initialStart, deltaDays);
        // Cannot push start past end; enforce 1-day minimum duration.
        const maxAllowed = addDays(drag.initialEnd, -(MIN_DAYS - 1));
        if (nextStart.getTime() > maxAllowed.getTime()) {
          nextStart = maxAllowed;
        }
      } else {
        nextEnd = addDays(drag.initialEnd, deltaDays);
        const minAllowed = addDays(drag.initialStart, MIN_DAYS - 1);
        if (nextEnd.getTime() < minAllowed.getTime()) {
          nextEnd = minAllowed;
        }
      }
      drag.currentStart = nextStart;
      drag.currentEnd = nextEnd;
      if (drag.moved) {
        setOverrides((prev) => ({
          ...prev,
          [drag.taskId]: { start: nextStart, end: nextEnd },
        }));
      }
    }
    function onUp(ev: PointerEvent) {
      const drag = activeDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      finishDrag(true);
    }
    function onCancel(ev: PointerEvent) {
      const drag = activeDragRef.current;
      if (!drag || drag.pointerId !== ev.pointerId) return;
      finishDrag(false);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [finishDrag, dayPx]);

  const beginDrag = useCallback(
    (e: React.PointerEvent, task: TaskWithPeople, mode: DragMode) => {
      e.preventDefault();
      const start = (task.startDate ?? task.dueDate) as Date;
      const end = (task.dueDate ?? task.startDate) as Date;
      activeDragRef.current = {
        taskId: task.id,
        mode,
        pointerId: e.pointerId,
        startX: e.clientX,
        initialStart: startOfDay(start),
        initialEnd: startOfDay(end),
        currentStart: startOfDay(start),
        currentEnd: startOfDay(end),
        moved: false,
      };
    },
    [],
  );

  // Keyboard rescheduling: focus a bar, then arrow keys move/resize. Each
  // keystroke commits immediately (no batching) - keeps the UX predictable.
  // Enter/Space open the task detail panel.
  const onBarKeyDown = useCallback(
    (e: React.KeyboardEvent, task: TaskWithPeople) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelectTask?.(task.id);
        return;
      }
      const start = (task.startDate ?? task.dueDate) as Date;
      const end = (task.dueDate ?? task.startDate) as Date;
      if (!start || !end) return;
      const stepDays = e.shiftKey ? 7 : 1;
      let nextStart = start;
      let nextEnd = end;
      let handled = true;
      if ((e.metaKey || e.ctrlKey) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        nextEnd = addDays(end, delta * stepDays);
        if (nextEnd.getTime() < addDays(start, MIN_DAYS - 1).getTime()) {
          nextEnd = addDays(start, MIN_DAYS - 1);
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const delta = e.key === 'ArrowRight' ? 1 : -1;
        nextStart = addDays(start, delta * stepDays);
        nextEnd = addDays(end, delta * stepDays);
      } else {
        handled = false;
      }
      if (!handled) return;
      e.preventDefault();
      const input: UpdateTaskInput = {};
      if (nextStart.getTime() !== start.getTime()) input.startDate = nextStart;
      if (nextEnd.getTime() !== end.getTime()) input.dueDate = nextEnd;
      if (Object.keys(input).length > 0) update.mutate({ id: task.id, input });
    },
    [update, onSelectTask],
  );

  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to today on mount + whenever zoom changes, so the bar at
  // today is centered in the viewport instead of hidden far to the right.
  useEffect(() => {
    if (!scrollerRef.current || !data?.range) return;
    const todayOffset = differenceInDays(startOfDay(new Date()), data.range.minDate) * dayPx;
    const containerWidth = scrollerRef.current.clientWidth;
    scrollerRef.current.scrollTo({
      left: Math.max(0, todayOffset - containerWidth / 2),
      behavior: 'auto',
    });
  }, [dayPx, data?.range]);

  const scrollToToday = () => {
    if (!scrollerRef.current || !data?.range) return;
    const todayOffset = differenceInDays(startOfDay(new Date()), data.range.minDate) * dayPx;
    const containerWidth = scrollerRef.current.clientWidth;
    scrollerRef.current.scrollTo({
      left: Math.max(0, todayOffset - containerWidth / 2),
      behavior: 'smooth',
    });
  };

  if (tasks.isError && !tasks.data) {
    return <QueryError message="Couldn't load tasks." onRetry={() => void tasks.refetch()} />;
  }

  if (tasks.isLoading || !data) {
    return <Skeleton className="h-72" />;
  }

  return (
    <section className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium uppercase tracking-wide">Timeline</span>
          {data.range ? (
            <span>
              {format(data.range.minDate, 'd MMM')} – {format(data.range.maxDate, 'd MMM yyyy')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Select value={zoom} onValueChange={(v) => setZoom(v as ZoomMode)}>
            <SelectTrigger className="h-8 w-[110px] text-xs" aria-label="Zoom">
              <SelectValue placeholder="Zoom" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week</SelectItem>
              <SelectItem value="month">Month</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="secondary"
            onClick={scrollToToday}
            disabled={!data.range}
            aria-label="Scroll to today"
          >
            Today
          </Button>
        </div>
      </div>

      {!data.range ? (
        <div className="rounded-md border-dashed p-8 text-center text-sm text-ink-muted">
          No tasks with dates yet. Set a due date or start date on a task to plot it here.
        </div>
      ) : (
        <TimelineGrid
          range={data.range}
          byStatus={data.byStatus}
          dayPx={dayPx}
          overrides={overrides}
          onBeginDrag={beginDrag}
          onBarKeyDown={onBarKeyDown}
          onSelectTask={onSelectTask}
          scrollerRef={scrollerRef}
        />
      )}

      {data.undated > 0 ? (
        <p className="border-t border-line px-3 py-2 text-xs text-ink-muted">
          {data.undated} task{data.undated === 1 ? '' : 's'} without dates - hidden.
        </p>
      ) : null}
    </section>
  );
}

function TimelineGrid({
  range,
  byStatus,
  dayPx,
  overrides,
  onBeginDrag,
  onBarKeyDown,
  onSelectTask,
  scrollerRef,
}: {
  range: { minDate: Date; maxDate: Date };
  byStatus: Map<string, TaskWithPeople[]>;
  dayPx: number;
  overrides: Record<string, { start: Date; end: Date }>;
  onBeginDrag: (e: React.PointerEvent, task: TaskWithPeople, mode: DragMode) => void;
  onBarKeyDown: (e: React.KeyboardEvent, task: TaskWithPeople) => void;
  onSelectTask: ((id: string) => void) | undefined;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { minDate, maxDate } = range;
  const totalDays = differenceInDays(maxDate, minDate);
  const todayOffset = differenceInDays(startOfDay(new Date()), minDate) * dayPx;
  return (
    <div className="flex">
      <div className="w-48 shrink-0 border-r border-line bg-bg-subtle">
        <div className="h-9 border-b border-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
          Tasks
        </div>
        {Array.from(byStatus.entries()).map(([status, list]) => (
          <div key={status}>
            <div className="bg-bg-subtle px-3 py-1 text-xs font-medium text-ink-muted">
              {status}
            </div>
            {list.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTask?.(t.id)}
                className="block w-full truncate border-b border-line px-3 py-1.5 text-left text-xs hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
                title={t.title}
              >
                {t.title}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div ref={scrollerRef} className="relative flex-1 overflow-x-auto">
        <div style={{ width: totalDays * dayPx, minWidth: '100%' }}>
          <DayHeader minDate={minDate} totalDays={totalDays} dayPx={dayPx} />
          {Array.from(byStatus.entries()).map(([status, list]) => (
            <div key={status}>
              <div className="h-6 bg-bg-subtle" />
              {list.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  minDate={minDate}
                  dayPx={dayPx}
                  override={overrides[t.id] ?? null}
                  onBeginDrag={(e, mode) => onBeginDrag(e, t, mode)}
                  onKeyDown={(e) => onBarKeyDown(e, t)}
                  onClick={onSelectTask ? () => onSelectTask(t.id) : undefined}
                />
              ))}
            </div>
          ))}
          {todayOffset >= 0 && todayOffset <= totalDays * dayPx ? (
            <div
              className="pointer-events-none absolute top-9 bottom-0 w-px bg-[#EAF0FC]0"
              style={{ left: todayOffset }}
              aria-hidden
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DayHeader({
  minDate,
  totalDays,
  dayPx,
}: {
  minDate: Date;
  totalDays: number;
  dayPx: number;
}) {
  // Label cadence scales with zoom - narrow cells skip labels so they don't
  // collide. Day=Mondays, Week=Mondays, Month=first-of-month only.
  const labelEvery = dayPx >= 28 ? 'mondays' : dayPx >= 14 ? 'mondays' : 'months';
  return (
    <div className="flex h-9 border-b border-line">
      {Array.from({ length: totalDays }).map((_, i) => {
        const d = addDays(minDate, i);
        const showLabel =
          labelEvery === 'months' ? d.getDate() === 1 : d.getDay() === 1;
        const labelText =
          labelEvery === 'months' ? format(d, 'MMM yyyy') : format(d, 'd MMM');
        return (
          <div
            key={i}
            className={`relative shrink-0 border-l border-line text-xs ${
              d.getDay() === 0 || d.getDay() === 6 ? 'bg-bg-subtle' : ''
            }`}
            style={{ width: dayPx }}
          >
            {showLabel ? (
              <span className="absolute left-1 top-1 whitespace-nowrap text-[10px] text-ink-muted">
                {labelText}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  minDate,
  dayPx,
  override,
  onBeginDrag,
  onKeyDown,
  onClick,
}: {
  task: TaskWithPeople;
  minDate: Date;
  dayPx: number;
  override: { start: Date; end: Date } | null;
  onBeginDrag: (e: React.PointerEvent, mode: DragMode) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onClick: (() => void) | undefined;
}) {
  const downXRef = useRef<number | null>(null);

  const start = override?.start ?? ((task.startDate ?? task.dueDate) as Date);
  const end = override?.end ?? ((task.dueDate ?? task.startDate) as Date);
  const left = differenceInDays(startOfDay(start), minDate) * dayPx;
  const days = Math.max(1, differenceInDays(startOfDay(end), startOfDay(start)) + 1);
  const width = Math.max(dayPx - 4, days * dayPx - 4);
  const onlyDue = !task.startDate && !!task.dueDate && !override;

  const handlePointerDown = (e: React.PointerEvent, mode: DragMode) => {
    downXRef.current = e.clientX;
    onBeginDrag(e, mode);
  };

  // Only fire the click when the pointer travelled less than the threshold,
  // i.e. the user genuinely clicked rather than dragged. We can't rely on
  // dnd-kit here because the drag is pointer-events-driven.
  const handleClick = (e: React.MouseEvent) => {
    const downX = downXRef.current;
    downXRef.current = null;
    if (downX !== null && Math.abs(e.clientX - downX) >= CLICK_DRAG_THRESHOLD_PX) return;
    onClick?.();
  };

  if (onlyDue) {
    return (
      <div className="relative h-7 border-b border-line">
        <button
          type="button"
          aria-label={`${task.title} - due ${format(end, 'd MMM')}. Drag to reschedule.`}
          onPointerDown={(e) => handlePointerDown(e, 'move')}
          onClick={handleClick}
          onKeyDown={onKeyDown}
          className="absolute top-1 h-5 w-5 rotate-45 bg-purple-500 cursor-grab focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
          style={{ left: left - 8, touchAction: 'none' }}
          title={`${task.title} · due ${format(end, 'd MMM')}`}
        />
      </div>
    );
  }
  return (
    <div className="relative h-7 border-b border-line">
      <div
        role="button"
        tabIndex={0}
        aria-label={`${task.title} - ${format(start, 'd MMM')} to ${format(end, 'd MMM')}. Drag to reschedule, Enter to open.`}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).dataset.handle) return;
          handlePointerDown(e, 'move');
        }}
        onClick={handleClick}
        onKeyDown={onKeyDown}
        className={cn(
          'group absolute top-1 h-5 rounded bg-[#EAF0FC]0/80 px-1.5 text-[10px] leading-5 text-white',
          'cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80',
        )}
        style={{ left, width, touchAction: 'none' }}
        title={`${task.title} · ${format(start, 'd MMM')} → ${format(end, 'd MMM')}`}
      >
        <span
          data-handle="start"
          aria-label="Resize start"
          onPointerDown={(e) => {
            e.stopPropagation();
            onBeginDrag(e, 'resize-start');
          }}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-blue-700/30 opacity-0 group-hover:opacity-100"
        />
        <span className="truncate">{task.title}</span>
        <span
          data-handle="end"
          aria-label="Resize end"
          onPointerDown={(e) => {
            e.stopPropagation();
            onBeginDrag(e, 'resize-end');
          }}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-blue-700/30 opacity-0 group-hover:opacity-100"
        />
      </div>
    </div>
  );
}
