'use client';

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AlertTriangle, Plus, Tag as TagIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectWithCreator,
  TaskPriority,
  TaskStatus,
  TaskWithPeople,
} from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { BulkActionBar } from '@/components/tasks/bulk-action-bar';
import {
  PriorityBadge,
  StatusBadge,
  priorityLabel,
} from '@/components/tasks/task-badges';
import { TaskFormDialog } from '@/components/tasks/task-form-dialog';
import { type BoardDensity, type BoardGroupBy } from '@/hooks/use-board-prefs';
import { useTaskSelection } from '@/hooks/use-task-selection';
import { matchesTaskFilters, type TaskFilters } from '@/hooks/use-task-filters';
import { useReorderTask, useTasks } from '@/hooks/use-tasks';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

const COLUMNS: { id: TaskStatus; label: string }[] = [
  { id: 'BACKLOG', label: 'Backlog' },
  { id: 'TODO', label: 'To do' },
  { id: 'IN_PROGRESS', label: 'In progress' },
  { id: 'IN_REVIEW', label: 'In review' },
  { id: 'DONE', label: 'Done' },
  { id: 'CANCELLED', label: 'Cancelled' },
];

const LANE_UNASSIGNED = '__unassigned__';
const LANE_STANDALONE = '__standalone__';
const LANE_NO_PRIORITY = '__nopri__';

type Lane = { id: string; label: string };

export interface BoardViewProps {
  projectId: string;
  project: ProjectWithCreator | null | undefined;
  density: BoardDensity;
  groupBy: BoardGroupBy;
  filters: TaskFilters;
  onSelectTask?: (id: string) => void;
}

export function BoardView({
  projectId,
  project,
  density,
  groupBy,
  filters,
  onSelectTask,
}: BoardViewProps) {
  const { data, isLoading, isError, refetch } = useTasks({ projectId, pageSize: 200 });
  const reorder = useReorderTask();
  const [creatingFor, setCreatingFor] = useState<TaskStatus | null>(null);
  const selection = useTaskSelection(projectId);

  // Apply client-side filters. The `tasks` query is shared with other views,
  // so we filter on the client instead of refetching with server-side params.
  const filtered = useMemo(() => {
    return (data?.items ?? []).filter((t) => matchesTaskFilters(t, filters));
  }, [data, filters]);

  // Resolve WIP limits off the project; missing key means "no limit".
  const wipLimits = useMemo(() => {
    const raw = (project?.workflowSettings as { wipLimits?: Record<string, number> } | undefined)
      ?.wipLimits;
    return raw ?? {};
  }, [project]);

  // Build the lanes for the currently active groupBy. Lanes are stable across
  // status columns so a card moving columns stays in the same lane.
  const lanes: Lane[] = useMemo(() => {
    if (groupBy === 'none') return [{ id: 'all', label: '' }];
    const items = filtered;
    if (groupBy === 'assignee') {
      const seen = new Map<string, Lane>();
      for (const t of items) {
        const u = t.assignee;
        const id = u?.id ?? LANE_UNASSIGNED;
        if (!seen.has(id)) {
          seen.set(id, { id, label: u ? u.name || u.email : 'Unassigned' });
        }
      }
      const ordered = [...seen.values()].filter((l) => l.id !== LANE_UNASSIGNED);
      ordered.sort((a, b) => a.label.localeCompare(b.label));
      if (seen.has(LANE_UNASSIGNED)) ordered.push(seen.get(LANE_UNASSIGNED)!);
      return ordered.length ? ordered : [{ id: 'all', label: '' }];
    }
    if (groupBy === 'priority') {
      const order: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
      const seen = new Set<TaskPriority>();
      for (const t of items) seen.add(t.priority);
      const result: Lane[] = order
        .filter((p) => seen.has(p))
        .map((p) => ({ id: p, label: priorityLabel(p) }));
      result.push({ id: LANE_NO_PRIORITY, label: 'No priority' });
      return result;
    }
    // Epic (parentTask root).
    const byEpic = new Map<string, Lane>();
    const titleOf = new Map<string, string>();
    for (const t of items) titleOf.set(t.id, t.title);
    for (const t of items) {
      const root = findRoot(t, items);
      if (!root) {
        if (!byEpic.has(LANE_STANDALONE)) {
          byEpic.set(LANE_STANDALONE, { id: LANE_STANDALONE, label: 'Standalone' });
        }
        continue;
      }
      if (!byEpic.has(root.id)) {
        byEpic.set(root.id, { id: root.id, label: root.title });
      }
    }
    const ordered = [...byEpic.values()].filter((l) => l.id !== LANE_STANDALONE);
    ordered.sort((a, b) => a.label.localeCompare(b.label));
    if (byEpic.has(LANE_STANDALONE)) ordered.push(byEpic.get(LANE_STANDALONE)!);
    return ordered.length ? ordered : [{ id: 'all', label: '' }];
  }, [filtered, groupBy]);

  const laneOf = useCallback(
    (t: TaskWithPeople): string => {
      if (groupBy === 'none') return 'all';
      if (groupBy === 'assignee') return t.assigneeId ?? LANE_UNASSIGNED;
      if (groupBy === 'priority') return t.priority;
      const root = findRoot(t, filtered);
      return root ? root.id : LANE_STANDALONE;
    },
    [groupBy, filtered],
  );

  // grouped[column][laneId] -> tasks (sorted by position).
  const grouped = useMemo(() => {
    const map = new Map<TaskStatus, Map<string, TaskWithPeople[]>>();
    for (const col of COLUMNS) {
      const lanesMap = new Map<string, TaskWithPeople[]>();
      for (const l of lanes) lanesMap.set(l.id, []);
      map.set(col.id, lanesMap);
    }
    for (const t of filtered) {
      const colMap = map.get(t.status);
      if (!colMap) continue;
      const lid = laneOf(t);
      const arr = colMap.get(lid) ?? [];
      arr.push(t);
      colMap.set(lid, arr);
    }
    for (const colMap of map.values()) {
      for (const arr of colMap.values()) {
        arr.sort((a, b) => a.position - b.position);
      }
    }
    return map;
  }, [filtered, lanes, laneOf]);

  // ---- Drag handling ----
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  const itemsRef = useRef(filtered);
  itemsRef.current = filtered;
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;
  const onSelectRef = useRef(onSelectTask);
  onSelectRef.current = onSelectTask;
  const inFlightRef = useRef(false);

  // Visible ids in column-first row-first order - needed by selection range.
  const visibleIdsRef = useRef<string[]>([]);
  visibleIdsRef.current = useMemo(() => {
    const ids: string[] = [];
    for (const col of COLUMNS) {
      const colMap = grouped.get(col.id);
      if (!colMap) continue;
      for (const lane of lanes) {
        for (const t of colMap.get(lane.id) ?? []) ids.push(t.id);
      }
    }
    return ids;
  }, [grouped, lanes]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback((e: DragEndEvent) => {
    if (!e.over) return;
    if (inFlightRef.current) return;
    const taskId = String(e.active.id);
    const overId = String(e.over.id);

    // overId can be a column id, a droppable swimlane (col__lane), or a task id.
    let overColumn: TaskStatus | undefined;
    if (overId.includes('__col__')) {
      overColumn = overId.split('__col__')[1] as TaskStatus;
    } else if ((COLUMNS as { id: string }[]).some((c) => c.id === overId)) {
      overColumn = overId as TaskStatus;
    } else {
      const found = itemsRef.current.find((t) => t.id === overId);
      if (found) overColumn = found.status;
    }
    if (!overColumn) return;

    const colMap = groupedRef.current.get(overColumn);
    if (!colMap) return;
    // Flatten the lanes of the column to get the global insertion index.
    const flat: { id: string }[] = [];
    for (const lane of colMap.values()) for (const t of lane) flat.push({ id: t.id });

    const targetIndex =
      overId === overColumn || overId.includes('__col__')
        ? flat.length
        : flat.findIndex((t) => t.id === overId);
    const newPos = targetIndex < 0 ? flat.length : targetIndex;

    const existing = itemsRef.current.find((t) => t.id === taskId);
    if (existing && existing.status === overColumn && existing.position === newPos) {
      return;
    }
    inFlightRef.current = true;
    reorderRef.current.mutate(
      { id: taskId, input: { taskId, status: overColumn, position: newPos } },
      {
        onSettled: () => {
          inFlightRef.current = false;
        },
      },
    );
  }, []);

  // ---- Selection keyboard shortcuts ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when the user is typing in an input/textarea/contenteditable.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (e.key === 'Escape' && selection.ids.size > 0) {
        e.preventDefault();
        selection.clear();
      } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        selection.selectMany(visibleIdsRef.current);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection]);

  const handleCardClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        e.preventDefault();
        selection.range(visibleIdsRef.current, id);
        return;
      }
      onSelectRef.current?.(id);
    },
    [selection],
  );

  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
        {COLUMNS.map((col) => (
          <div key={col.id} className="w-[80vw] max-w-[18rem] shrink-0 rounded-lg bg-bg-subtle p-2 md:w-72 md:max-w-none">
            <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink">
              {col.label}
            </div>
            <div className="mt-1 space-y-2 p-1">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (isError && !data) {
    return <QueryError message="Couldn't load tasks." onRetry={() => void refetch()} />;
  }

  const showLanes = groupBy !== 'none' && lanes.length > 1;
  const selectedIds = [...selection.ids];

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
          <div
            className="flex"
            style={{
              minWidth: showLanes ? `${156 + COLUMNS.length * 296}px` : undefined,
            }}
          >
            {showLanes ? (
              <div className="sticky left-0 z-20 w-[112px] shrink-0 bg-white md:w-[156px]">
                <div className="h-9" aria-hidden />
                <div className="space-y-3 pr-2">
                  {lanes.map((lane) => (
                    <div
                      key={lane.id}
                      className="rounded-md bg-bg-subtle px-3 py-2 text-xs font-medium text-ink"
                    >
                      <span className="line-clamp-2">{lane.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex gap-3">
              {COLUMNS.map((col) => (
                <Column
                  key={col.id}
                  id={col.id}
                  label={col.label}
                  lanes={lanes}
                  showLanes={showLanes}
                  groupedByLane={grouped.get(col.id) ?? new Map()}
                  density={density}
                  selectedIds={selection.ids}
                  onToggleSelect={selection.toggle}
                  onClickCard={handleCardClick}
                  onAdd={() => setCreatingFor(col.id)}
                  wipLimit={wipLimits[col.id] ?? null}
                />
              ))}
            </div>
          </div>
        </div>
      </DndContext>

      <BulkActionBar
        projectId={projectId}
        selectedIds={selectedIds}
        onClear={selection.clear}
      />

      {creatingFor ? (
        <TaskFormDialog
          projectId={projectId}
          defaultStatus={creatingFor}
          onClose={() => setCreatingFor(null)}
        />
      ) : null}
    </>
  );
}

function Column({
  id,
  label,
  lanes,
  showLanes,
  groupedByLane,
  density,
  selectedIds,
  onToggleSelect,
  onClickCard,
  onAdd,
  wipLimit,
}: {
  id: TaskStatus;
  label: string;
  lanes: Lane[];
  showLanes: boolean;
  groupedByLane: Map<string, TaskWithPeople[]>;
  density: BoardDensity;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onClickCard: (id: string, e: React.MouseEvent) => void;
  onAdd: () => void;
  wipLimit: number | null;
}) {
  const total = [...groupedByLane.values()].reduce((acc, arr) => acc + arr.length, 0);
  const atLimit = wipLimit != null && total >= wipLimit;
  const overLimit = wipLimit != null && total > wipLimit;
  return (
    <div
      className={cn(
        'w-72 shrink-0 rounded-lg bg-bg-subtle p-2',
        atLimit && 'border border-red-400',
      )}
    >
      <div className="flex h-9 items-center justify-between px-2">
        <div className="min-w-0 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink">
          <span className="truncate" title={label}>{label}</span>
          <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
            {wipLimit != null ? `${total} / ${wipLimit}` : total}
          </span>
          {atLimit ? (
            <Tooltip
              content={
                overLimit
                  ? `Over WIP limit (${total} > ${wipLimit}). Move tasks out to clear the warning.`
                  : `At WIP limit (${total} / ${wipLimit}).`
              }
            >
              <span
                className="whitespace-nowrap inline-flex items-center gap-1 rounded-full bg-tint-error px-1.5 py-0.5 text-[10px] font-medium text-state-error"
                role="status"
              >
                <AlertTriangle className="h-3 w-3" aria-hidden />
                WIP exceeded
              </span>
            </Tooltip>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" aria-label={`Add task to ${label}`} onClick={onAdd}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <ColumnBody
        columnId={id}
        lanes={lanes}
        showLanes={showLanes}
        groupedByLane={groupedByLane}
        density={density}
        selectedIds={selectedIds}
        onToggleSelect={onToggleSelect}
        onClickCard={onClickCard}
      />
    </div>
  );
}

function ColumnBody({
  columnId,
  lanes,
  showLanes,
  groupedByLane,
  density,
  selectedIds,
  onToggleSelect,
  onClickCard,
}: {
  columnId: TaskStatus;
  lanes: Lane[];
  showLanes: boolean;
  groupedByLane: Map<string, TaskWithPeople[]>;
  density: BoardDensity;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onClickCard: (id: string, e: React.MouseEvent) => void;
}) {
  // A single sortable context per column keeps cross-lane drags within the same
  // column working correctly while swimlanes only segment by lane label.
  const allIds = useMemo(() => {
    const ids: string[] = [];
    for (const lane of lanes) {
      for (const t of groupedByLane.get(lane.id) ?? []) ids.push(t.id);
    }
    return ids;
  }, [lanes, groupedByLane]);

  const { setNodeRef, isOver } = useDroppable({ id: columnId });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mt-1 min-h-[200px] rounded-md p-1 transition-colors',
        isOver && 'bg-brand-50',
      )}
    >
      <SortableContext items={allIds} strategy={verticalListSortingStrategy}>
        {showLanes ? (
          <div className="space-y-3">
            {lanes.map((lane) => (
              <LaneArea
                key={lane.id}
                laneId={lane.id}
                columnId={columnId}
                tasks={groupedByLane.get(lane.id) ?? []}
                density={density}
                selectedIds={selectedIds}
                onToggleSelect={onToggleSelect}
                onClickCard={onClickCard}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {[...groupedByLane.values()].flat().map((t) => (
              <Card
                key={t.id}
                task={t}
                density={density}
                selected={selectedIds.has(t.id)}
                onToggleSelect={onToggleSelect}
                onClickCard={onClickCard}
              />
            ))}
          </div>
        )}
      </SortableContext>
    </div>
  );
}

function LaneArea({
  laneId,
  columnId,
  tasks,
  density,
  selectedIds,
  onToggleSelect,
  onClickCard,
}: {
  laneId: string;
  columnId: TaskStatus;
  tasks: TaskWithPeople[];
  density: BoardDensity;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onClickCard: (id: string, e: React.MouseEvent) => void;
}) {
  // Each lane is its own droppable region so the user can drop into an empty
  // lane. The id encodes both column and lane so the drag-end handler can
  // recover the destination column.
  const { setNodeRef, isOver } = useDroppable({ id: `${laneId}__col__${columnId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'min-h-[60px] space-y-2 rounded-md border border-dashed border-transparent p-1',
        isOver && 'border-brand-400 bg-brand-50/60',
      )}
    >
      {tasks.map((t) => (
        <Card
          key={t.id}
          task={t}
          density={density}
          selected={selectedIds.has(t.id)}
          onToggleSelect={onToggleSelect}
          onClickCard={onClickCard}
        />
      ))}
    </div>
  );
}

function Card({
  task,
  density,
  selected,
  onToggleSelect,
  onClickCard,
}: {
  task: TaskWithPeople;
  density: BoardDensity;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onClickCard: (id: string, e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const padding = density === 'compact' ? 'p-2' : 'p-3';
  const showAvatar = density !== 'compact';
  const showMeta = density !== 'compact';
  const showDetailed = density === 'detailed';

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      aria-pressed={selected || undefined}
      onClick={(e) => {
        if (isDragging) return;
        e.stopPropagation();
        onClickCard(task.id, e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClickCard(task.id, e as unknown as React.MouseEvent);
        }
      }}
      className={cn(
        'group rounded-lg border bg-white shadow-sm cursor-grab active:cursor-grabbing',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        'hover:border-line-strong transition-colors',
        selected ? 'border-brand-purple ring-2 ring-brand-500/20' : 'border-line',
        padding,
      )}
    >
      <div className="flex items-start gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(task.id)}
          onClick={(e) => e.stopPropagation()}
          // Stop pointer events from bubbling so we don't initiate a drag.
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Select ${task.title}`}
          className="mt-0.5 opacity-0 group-hover:opacity-100 data-[state=checked]:opacity-100 focus-visible:opacity-100"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink leading-snug">{task.title}</div>
          {showDetailed && task.description ? (
            <p className="mt-1 line-clamp-1 text-xs text-ink-muted">{task.description}</p>
          ) : null}
        </div>
      </div>
      {showMeta ? (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <PriorityBadge priority={task.priority} />
            {showDetailed ? <StatusBadge status={task.status} /> : null}
          </div>
          {showAvatar && task.assignee ? (
            <UserAvatar
              size="sm"
              name={task.assignee.name || task.assignee.email}
              image={task.assignee.image}
            />
          ) : null}
        </div>
      ) : null}
      {showDetailed ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
          {task.dueDate ? (
            <Tooltip content={absoluteTime(task.dueDate)}>
              <span>{relativeTime(task.dueDate)}</span>
            </Tooltip>
          ) : null}
          {task.estimateHours ? <span>{task.estimateHours}h</span> : null}
          <span className="inline-flex items-center gap-1">
            <TagIcon className="h-3 w-3" aria-hidden />0
          </span>
        </div>
      ) : null}
    </div>
  );
}

function findRoot(t: TaskWithPeople, all: TaskWithPeople[]): TaskWithPeople | null {
  if (!t.parentTaskId) return null;
  let cur: TaskWithPeople | undefined = t;
  // Walk up at most 10 ancestors to defend against cyclic data.
  for (let i = 0; i < 10; i++) {
    if (!cur || !cur.parentTaskId) return cur && cur.id !== t.id ? cur : null;
    const parent: TaskWithPeople | undefined = all.find((x) => x.id === cur!.parentTaskId);
    if (!parent) return cur && cur.id !== t.id ? cur : null;
    cur = parent;
  }
  return cur ?? null;
}
