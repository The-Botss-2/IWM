'use client';

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfDay,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type {
  ProjectWithCreator,
  TaskPriority,
  TaskStatus,
  TaskWithPeople,
} from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { useProject } from '@/hooks/use-projects';
import { useTasks, useUpdateTask } from '@/hooks/use-tasks';
import { cn } from '@/lib/utils';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type ColorMode = 'project' | 'status' | 'priority' | 'assignee';

// 12-color qualitative palette - derived from Tailwind 500-tier colors with
// distinct hue spacing. Used for the deterministic assignee color hash.
const ASSIGNEE_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#06b6d4',
  '#a855f7',
  '#22c55e',
  '#eab308',
];

const STATUS_COLORS: Record<TaskStatus, string> = {
  BACKLOG: '#94a3b8',
  TODO: '#64748b',
  IN_PROGRESS: '#3b82f6',
  IN_REVIEW: '#f59e0b',
  DONE: '#22c55e',
  CANCELLED: '#94a3b8',
};

const PRIORITY_COLORS: Record<TaskPriority, string> = {
  LOW: '#94a3b8',
  MEDIUM: '#3b82f6',
  HIGH: '#f59e0b',
  URGENT: '#ef4444',
};

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function pickAssigneeColor(userId: string): string {
  return ASSIGNEE_PALETTE[hashId(userId) % ASSIGNEE_PALETTE.length]!;
}

function colorFor(
  task: TaskWithPeople,
  mode: ColorMode,
  projectColor: string,
): string {
  if (mode === 'status') return STATUS_COLORS[task.status];
  if (mode === 'priority') return PRIORITY_COLORS[task.priority];
  if (mode === 'assignee') {
    return task.assigneeId ? pickAssigneeColor(task.assigneeId) : '#94a3b8';
  }
  return projectColor;
}

export default function CalendarView({
  projectId,
  onSelectTask,
}: {
  projectId: string;
  onSelectTask?: (id: string) => void;
}) {
  const tasks = useTasks({ projectId, pageSize: 200 });
  const project = useProject(projectId);
  const update = useUpdateTask();
  const [cursor, setCursor] = useState(() => new Date());
  const [colorMode, setColorMode] = useState<ColorMode>('project');

  const projectColor = project.data?.color ?? '#6366f1';

  const grid = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const dayKeys = useMemo(() => grid.map((d) => format(d, 'yyyy-MM-dd')), [grid]);

  // Partition tasks into segments per week so a multi-day bar can render
  // across days inside a week, breaking at the weekly boundary.
  const segments = useMemo(
    () => buildSegments(tasks.data?.items ?? [], grid),
    [tasks.data, grid],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = (_e: DragStartEvent) => {
    // Intentional no-op - we drive the drag overlay via DndContext defaults.
  };

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      if (!e.over) return;
      const id = String(e.active.id);
      const dropDay = String(e.over.id);
      const task = tasks.data?.items.find((t) => t.id === id);
      if (!task) return;
      const targetDay = startOfDay(parseDayKey(dropDay));
      if (task.startDate && task.dueDate) {
        // Multi-day bar: preserve duration by shifting both edges by the same delta.
        const start = startOfDay(task.startDate);
        const end = startOfDay(task.dueDate);
        // The drag id encodes which edge or body was active.
        const handle = e.active.data.current?.handle as
          | 'body'
          | 'start'
          | 'end'
          | undefined;
        if (handle === 'start') {
          const cappedStart = targetDay.getTime() > end.getTime() ? end : targetDay;
          update.mutate({ id, input: { startDate: cappedStart } });
          return;
        }
        if (handle === 'end') {
          const cappedEnd = targetDay.getTime() < start.getTime() ? start : targetDay;
          update.mutate({ id, input: { dueDate: cappedEnd } });
          return;
        }
        const delta = differenceInCalendarDays(targetDay, start);
        update.mutate({
          id,
          input: { startDate: addDays(start, delta), dueDate: addDays(end, delta) },
        });
        return;
      }
      // Single-day chip: just move dueDate.
      update.mutate({ id, input: { dueDate: targetDay } });
    },
    [tasks.data, update],
  );

  if (tasks.isLoading) {
    return (
      <section className="rounded-lg border border-line bg-white p-4">
        <Skeleton className="mt-4 h-96" />
      </section>
    );
  }

  if (tasks.isError && !tasks.data) {
    return <QueryError message="Couldn't load tasks." onRetry={() => void tasks.refetch()} />;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <section className="rounded-lg border border-line bg-white p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous month"
              onClick={() => setCursor((d) => subMonths(d, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h3 className="text-sm font-semibold">{format(cursor, 'MMMM yyyy')}</h3>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next month"
              onClick={() => setCursor((d) => addMonths(d, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCursor(new Date())}>
              Today
            </Button>
          </div>
          <Select value={colorMode} onValueChange={(v) => setColorMode(v as ColorMode)}>
            <SelectTrigger className="h-8 w-fit min-w-[140px] text-xs" aria-label="Color by">
              <SelectValue placeholder="Color by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">Color by project</SelectItem>
              <SelectItem value="status">Color by status</SelectItem>
              <SelectItem value="priority">Color by priority</SelectItem>
              <SelectItem value="assignee">Color by assignee</SelectItem>
            </SelectContent>
          </Select>
        </header>

        <div className="mt-4 grid grid-cols-7 gap-px overflow-hidden rounded-md bg-line text-xs">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="bg-bg-subtle px-2 py-1 text-xs font-medium uppercase tracking-wide text-ink-muted"
            >
              {d}
            </div>
          ))}
          {grid.map((day, idx) => {
            const key = dayKeys[idx]!;
            const isCurrentMonth = isSameMonth(day, cursor);
            const isToday = isSameDay(day, new Date());
            const daySegments = segments.get(key) ?? [];
            return (
              <DayCell
                key={key}
                day={day}
                isCurrentMonth={isCurrentMonth}
                isToday={isToday}
                segments={daySegments}
                colorMode={colorMode}
                projectColor={projectColor}
                project={project.data}
                onSelectTask={onSelectTask}
              />
            );
          })}
        </div>

        {colorMode !== 'project' ? (
          <Legend colorMode={colorMode} tasks={tasks.data?.items ?? []} />
        ) : null}
      </section>
    </DndContext>
  );
}

interface Segment {
  taskId: string;
  task: TaskWithPeople;
  /** Whether this is the leftmost segment of the original range. */
  isStart: boolean;
  /** Whether this is the rightmost segment. */
  isEnd: boolean;
}

function buildSegments(
  tasks: TaskWithPeople[],
  grid: Date[],
): Map<string, Segment[]> {
  const map = new Map<string, Segment[]>();
  if (grid.length === 0) return map;
  const firstGrid = startOfDay(grid[0]!);
  const lastGrid = startOfDay(grid[grid.length - 1]!);

  for (const t of tasks) {
    if (!t.dueDate && !t.startDate) continue;
    const due = startOfDay((t.dueDate ?? t.startDate) as Date);
    const start = startOfDay((t.startDate ?? t.dueDate) as Date);
    if (start.getTime() > lastGrid.getTime() || due.getTime() < firstGrid.getTime()) {
      continue;
    }
    let cursor = start.getTime() < firstGrid.getTime() ? firstGrid : start;
    const final = due.getTime() > lastGrid.getTime() ? lastGrid : due;
    while (cursor.getTime() <= final.getTime()) {
      const isStart = cursor.getTime() === start.getTime();
      const isEnd = cursor.getTime() === due.getTime();
      const key = format(cursor, 'yyyy-MM-dd');
      const arr = map.get(key) ?? [];
      arr.push({ taskId: t.id, task: t, isStart, isEnd });
      map.set(key, arr);
      cursor = addDays(cursor, 1);
    }
  }
  return map;
}

function DayCell({
  day,
  isCurrentMonth,
  isToday,
  segments,
  colorMode,
  projectColor,
  project,
  onSelectTask,
}: {
  day: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  segments: Segment[];
  colorMode: ColorMode;
  projectColor: string;
  project: ProjectWithCreator | null | undefined;
  onSelectTask: ((id: string) => void) | undefined;
}) {
  void project;
  const key = format(day, 'yyyy-MM-dd');
  const { setNodeRef, isOver } = useDroppable({ id: key });
  const visible = segments.slice(0, 4);
  const overflow = segments.length > 4 ? segments.slice(4) : [];
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[88px] bg-white p-1.5',
        !isCurrentMonth && 'opacity-50',
        isOver && 'ring-2 ring-inset ring-brand-400',
      )}
    >
      <div
        className={cn(
          'mb-1 text-right text-xs',
          isToday ? 'font-semibold text-brand-blue' : 'text-ink-muted',
        )}
      >
        {format(day, 'd')}
      </div>
      <ul className="space-y-1">
        {visible.map((seg) => (
          <CalendarChip
            key={`${seg.taskId}-${key}`}
            segment={seg}
            dayKey={key}
            color={colorFor(seg.task, colorMode, projectColor)}
            onSelectTask={onSelectTask}
          />
        ))}
        {overflow.length > 0 ? (
          <li>
            <DayOverflowPopover
              day={day}
              overflow={overflow}
              colorMode={colorMode}
              projectColor={projectColor}
              onSelectTask={onSelectTask}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function DayOverflowPopover({
  day,
  overflow,
  colorMode,
  projectColor,
  onSelectTask,
}: {
  day: Date;
  overflow: Segment[];
  colorMode: ColorMode;
  projectColor: string;
  onSelectTask: ((id: string) => void) | undefined;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded px-1 text-[11px] text-ink-muted hover:bg-bg-subtle hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          aria-label={`Show ${overflow.length} more task${overflow.length === 1 ? '' : 's'} for ${format(day, 'd MMM yyyy')}`}
        >
          +{overflow.length} more
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          {format(day, 'EEE d MMM')}
        </div>
        <ul className="space-y-1">
          {overflow.map((seg) => (
            <li key={seg.taskId}>
              <button
                type="button"
                onClick={() => onSelectTask?.(seg.taskId)}
                disabled={!onSelectTask}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg-subtle disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
              >
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: colorFor(seg.task, colorMode, projectColor) }}
                  aria-hidden
                />
                <span className="truncate">{seg.task.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function CalendarChip({
  segment,
  dayKey,
  color,
  onSelectTask,
}: {
  segment: Segment;
  dayKey: string;
  color: string;
  onSelectTask: ((id: string) => void) | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${segment.taskId}__${dayKey}`,
    data: { taskId: segment.taskId, handle: 'body' as const },
  });
  const style: React.CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : 1,
    background: color,
    color: '#ffffff',
    borderRadius: `${segment.isStart ? 4 : 0}px ${segment.isEnd ? 4 : 0}px ${segment.isEnd ? 4 : 0}px ${segment.isStart ? 4 : 0}px`,
  };
  // dnd-kit's MouseSensor only promotes to a drag after the activation
  // distance is met (4 px). A pointer-up before that fires a normal click,
  // so opening the detail panel from a click works without extra plumbing.
  // We still guard for `isDragging` so a chip released mid-drag doesn't
  // double-open.
  const handleClick = () => {
    if (isDragging) return;
    onSelectTask?.(segment.taskId);
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectTask?.(segment.taskId);
    }
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-label={`${segment.task.title} - drag to reschedule, Enter to open`}
      className={cn(
        'truncate px-1.5 py-0.5 text-[11px] cursor-grab active:cursor-grabbing',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60',
      )}
    >
      {segment.isStart ? segment.task.title : '…'}
    </li>
  );
}

function Legend({
  colorMode,
  tasks,
}: {
  colorMode: ColorMode;
  tasks: TaskWithPeople[];
}) {
  if (colorMode === 'status') {
    return (
      <ul className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
        {(Object.keys(STATUS_COLORS) as TaskStatus[]).map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded"
              style={{ background: STATUS_COLORS[s] }}
              aria-hidden
            />
            <span>{statusLabel(s)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (colorMode === 'priority') {
    return (
      <ul className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
        {(Object.keys(PRIORITY_COLORS) as TaskPriority[]).map((p) => (
          <li key={p} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-3 rounded"
              style={{ background: PRIORITY_COLORS[p] }}
              aria-hidden
            />
            <span>{priorityLabel(p)}</span>
          </li>
        ))}
      </ul>
    );
  }
  const seen = new Map<string, { name: string; color: string }>();
  for (const t of tasks) {
    if (!t.assigneeId || seen.has(t.assigneeId)) continue;
    seen.set(t.assigneeId, {
      name: t.assignee?.name || t.assignee?.email || 'Unknown',
      color: pickAssigneeColor(t.assigneeId),
    });
  }
  return (
    <ul className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
      {[...seen.entries()].map(([id, info]) => (
        <li key={id} className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ background: info.color }}
            aria-hidden
          />
          <span className="truncate max-w-[160px]">{info.name}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="inline-block h-3 w-3 rounded-full bg-slate-400" aria-hidden />
        <span>Unassigned</span>
      </li>
    </ul>
  );
}

function buildMonthGrid(date: Date): Date[] {
  // Monday-first grid covering the whole month plus padding to align weeks.
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  const start = startOfWeek(first, { weekStartsOn: 1 });
  const end = endOfWeek(last, { weekStartsOn: 1 });
  const total = differenceInCalendarDays(end, start) + 1;
  return Array.from({ length: total }, (_, i) => addDays(start, i));
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map((x) => Number.parseInt(x, 10));
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}
