'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SprintWithStats,
  TaskPriority,
  TaskStatus,
  TaskWithPeople,
  UpdateTaskInput,
} from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import { BulkActionBar } from '@/components/tasks/bulk-action-bar';
import {
  PRIORITY_OPTIONS,
  PriorityBadge,
  STATUS_OPTIONS,
  StatusBadge,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { customFieldIdOf, type ListColumn, type ListGroupBy } from '@/hooks/use-board-prefs';
import { type ListFieldColumn, useTaskListFieldColumns } from '@/hooks/use-custom-fields';
import { useIsSmall } from '@/hooks/use-media-query';
import { useSprints } from '@/hooks/use-sprints';
import { useTaskSelection } from '@/hooks/use-task-selection';
import { matchesTaskFilters, type TaskFilters } from '@/hooks/use-task-filters';
import { useTasks, useUpdateTask } from '@/hooks/use-tasks';
import { absoluteTime, isOverdue, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

type SortKey = 'title' | 'status' | 'priority' | 'assignee' | 'dueDate' | 'updatedAt';

const PRIORITY_RANK: Record<TaskPriority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 };
const STATUS_RANK: Record<TaskStatus, number> = {
  BACKLOG: 0,
  TODO: 1,
  IN_PROGRESS: 2,
  IN_REVIEW: 3,
  DONE: 4,
  CANCELLED: 5,
};

const ROW_HEIGHT = 56;

/** Read-only custom-field columns: which to show, and each cell's text. */
interface FieldCols {
  fields: ListFieldColumn[];
  textFor: (taskId: string, definition: ListFieldColumn['definition']) => string;
}
const VIRTUALIZATION_THRESHOLD = 50;

export interface TaskListViewProps {
  projectId: string;
  filters: TaskFilters;
  groupBy: ListGroupBy;
  columns: ListColumn[];
  onSelect: (taskId: string) => void;
}

export function TaskListView({
  projectId,
  filters,
  groupBy,
  columns,
  onSelect,
}: TaskListViewProps) {
  const { data, isLoading, isError, refetch } = useTasks({ projectId, pageSize: 200 });
  const sprints = useSprints(projectId);
  const selection = useTaskSelection(projectId);
  const fieldCols = useTaskListFieldColumns(projectId, columns);

  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'updatedAt',
    dir: 'desc',
  });

  // Apply filters client-side. Same predicate as BoardView so the row counts
  // line up between the two views.
  const filtered = useMemo(() => {
    return (data?.items ?? []).filter((t) => matchesTaskFilters(t, filters));
  }, [data, filters]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sort.key) {
        case 'title':
          return a.title.localeCompare(b.title) * dir;
        case 'status':
          return (STATUS_RANK[a.status] - STATUS_RANK[b.status]) * dir;
        case 'priority':
          return (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) * dir;
        case 'assignee':
          return (a.assignee?.name ?? '').localeCompare(b.assignee?.name ?? '') * dir;
        case 'dueDate': {
          const av = a.dueDate ? a.dueDate.getTime() : Number.POSITIVE_INFINITY;
          const bv = b.dueDate ? b.dueDate.getTime() : Number.POSITIVE_INFINITY;
          return (av - bv) * dir;
        }
        case 'updatedAt':
          return (a.updatedAt.getTime() - b.updatedAt.getTime()) * dir;
        default:
          return 0;
      }
    });
    return arr;
  }, [filtered, sort]);

  const onSortClick = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  };

  // Build groupings (Status, Assignee, Priority, Sprint, None).
  const groups = useMemo(
    () => buildGroups(sorted, groupBy, sprints.data ?? []),
    [sorted, groupBy, sprints.data],
  );

  // Selection bookkeeping.
  useEffect(() => {
    // Selection is set up by the parent project page. Nothing to do here.
  }, [projectId]);

  // Keyboard: Esc clears selection, Cmd+A selects all visible.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (e.key === 'Escape' && selection.ids.size > 0) {
        e.preventDefault();
        selection.clear();
      } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        selection.selectMany(sorted.map((t) => t.id));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, sorted]);

  return (
    <div className="space-y-3">
      {isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : isError && !data ? (
        <QueryError message="Couldn't load tasks." onRetry={() => void refetch()} />
      ) : sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <GroupedTable
          projectId={projectId}
          groups={groups}
          columns={columns}
          fieldCols={fieldCols}
          sort={sort}
          onSortClick={onSortClick}
          onSelect={onSelect}
          selectionSet={selection.ids}
          onToggleSelect={selection.toggle}
          onShiftRange={(id) => selection.range(sorted.map((t) => t.id), id)}
        />
      )}

      <BulkActionBar
        projectId={projectId}
        selectedIds={[...selection.ids]}
        onClear={selection.clear}
      />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-line bg-white p-10 text-center">
      <p className="text-sm font-medium text-ink">No tasks match.</p>
      <p className="mt-1 text-sm text-ink-muted">Try removing a filter, or clearing the search.</p>
    </div>
  );
}

interface Group {
  id: string;
  label: string;
  tasks: TaskWithPeople[];
}

function buildGroups(
  tasks: TaskWithPeople[],
  groupBy: ListGroupBy,
  sprintsList: SprintWithStats[],
): Group[] {
  if (groupBy === 'none') {
    return [{ id: 'all', label: 'All tasks', tasks }];
  }
  if (groupBy === 'status') {
    const order = STATUS_OPTIONS;
    return order
      .map((s) => ({
        id: s,
        label: statusLabel(s),
        tasks: tasks.filter((t) => t.status === s),
      }))
      .filter((g) => g.tasks.length > 0);
  }
  if (groupBy === 'priority') {
    const order: TaskPriority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
    return order
      .map((p) => ({
        id: p,
        label: priorityLabel(p),
        tasks: tasks.filter((t) => t.priority === p),
      }))
      .filter((g) => g.tasks.length > 0);
  }
  if (groupBy === 'assignee') {
    const map = new Map<string, Group>();
    for (const t of tasks) {
      const id = t.assigneeId ?? '__unassigned__';
      const label = t.assignee ? t.assignee.name || t.assignee.email : 'Unassigned';
      const g = map.get(id) ?? { id, label, tasks: [] };
      g.tasks.push(t);
      map.set(id, g);
    }
    const arr = [...map.values()].filter((g) => g.id !== '__unassigned__');
    arr.sort((a, b) => a.label.localeCompare(b.label));
    if (map.has('__unassigned__')) arr.push(map.get('__unassigned__')!);
    return arr;
  }
  // sprint
  const taskToSprintId = new Map<string, string>();
  for (const s of sprintsList) {
    for (const tid of s.taskIds) taskToSprintId.set(tid, s.id);
  }
  const map = new Map<string, Group>();
  for (const s of sprintsList) {
    map.set(s.id, { id: s.id, label: s.name, tasks: [] });
  }
  map.set('__none__', { id: '__none__', label: 'Not in a sprint', tasks: [] });
  for (const t of tasks) {
    const sid = taskToSprintId.get(t.id) ?? '__none__';
    map.get(sid)!.tasks.push(t);
  }
  return [...map.values()].filter((g) => g.tasks.length > 0);
}

function GroupedTable({
  projectId,
  groups,
  columns,
  fieldCols,
  sort,
  onSortClick,
  onSelect,
  selectionSet,
  onToggleSelect,
  onShiftRange,
}: {
  projectId: string;
  groups: Group[];
  columns: ListColumn[];
  fieldCols: FieldCols;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSortClick: (k: SortKey) => void;
  onSelect: (id: string) => void;
  selectionSet: Set<string>;
  onToggleSelect: (id: string) => void;
  onShiftRange: (id: string) => void;
}) {
  const isSmall = useIsSmall();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  if (isSmall) {
    return (
      <div className="space-y-3">
        {groups.map((g) => (
          <CardListGroup
            key={g.id}
            group={g}
            collapsed={collapsed.has(g.id)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(g.id)) next.delete(g.id);
                else next.add(g.id);
                return next;
              })
            }
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-10 bg-bg-subtle text-left text-xs font-medium uppercase tracking-wide text-ink-muted">
          <tr>
            <th className="w-10 px-3 py-2" aria-label="Select" />
            <SortHeader label="Title" sortKey="title" sort={sort} onClick={onSortClick} />
            {columns.includes('status') ? (
              <SortHeader label="Status" sortKey="status" sort={sort} onClick={onSortClick} />
            ) : null}
            {columns.includes('priority') ? (
              <SortHeader label="Priority" sortKey="priority" sort={sort} onClick={onSortClick} />
            ) : null}
            {columns.includes('assignee') ? (
              <SortHeader
                label="Assignee"
                sortKey="assignee"
                sort={sort}
                onClick={onSortClick}
              />
            ) : null}
            {columns.includes('due') ? (
              <SortHeader label="Due" sortKey="dueDate" sort={sort} onClick={onSortClick} />
            ) : null}
            {columns.includes('updated') ? (
              <SortHeader label="Updated" sortKey="updatedAt" sort={sort} onClick={onSortClick} />
            ) : null}
            {columns.includes('description') ? (
              <th className="px-3 py-2">Description</th>
            ) : null}
            {columns.includes('sprint') ? <th className="px-3 py-2">Sprint</th> : null}
            {columns.includes('estimate') ? <th className="px-3 py-2">Estimate</th> : null}
            {fieldCols.fields.map((f) => (
              <th key={f.column} className="px-3 py-2">
                {f.definition.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.id);
            return (
              <FragmentGroup
                key={g.id}
                group={g}
                projectId={projectId}
                columns={columns}
                fieldCols={fieldCols}
                isCollapsed={isCollapsed}
                onToggleCollapse={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.id)) next.delete(g.id);
                    else next.add(g.id);
                    return next;
                  })
                }
                selectionSet={selectionSet}
                onToggleSelect={onToggleSelect}
                onShiftRange={onShiftRange}
                onSelect={onSelect}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FragmentGroup({
  group,
  projectId,
  columns,
  fieldCols,
  isCollapsed,
  onToggleCollapse,
  selectionSet,
  onToggleSelect,
  onShiftRange,
  onSelect,
}: {
  group: Group;
  projectId: string;
  columns: ListColumn[];
  fieldCols: FieldCols;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  selectionSet: Set<string>;
  onToggleSelect: (id: string) => void;
  onShiftRange: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const totalCols =
    2 +
    (columns.includes('status') ? 1 : 0) +
    (columns.includes('priority') ? 1 : 0) +
    (columns.includes('assignee') ? 1 : 0) +
    (columns.includes('due') ? 1 : 0) +
    (columns.includes('updated') ? 1 : 0) +
    (columns.includes('description') ? 1 : 0) +
    (columns.includes('sprint') ? 1 : 0) +
    (columns.includes('estimate') ? 1 : 0) +
    fieldCols.fields.length;

  const tasksToShow = isCollapsed ? [] : group.tasks;
  const isVirtual = tasksToShow.length > VIRTUALIZATION_THRESHOLD;
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tasksToShow.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    enabled: isVirtual,
  });

  return (
    <>
      <tr>
        <td colSpan={totalCols} className="bg-bg-subtle px-3 py-1.5">
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex w-full items-center gap-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink"
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            <span>{group.label}</span>
            <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-mono text-ink-muted">
              {group.tasks.length}
            </span>
          </button>
        </td>
      </tr>
      {!isCollapsed && !isVirtual
        ? tasksToShow.map((t) => (
            <EditableRow
              key={t.id}
              task={t}
              projectId={projectId}
              columns={columns}
              fieldCols={fieldCols}
              selected={selectionSet.has(t.id)}
              onToggleSelect={onToggleSelect}
              onShiftRange={onShiftRange}
              onSelect={onSelect}
            />
          ))
        : null}
      {!isCollapsed && isVirtual ? (
        <tr>
          <td colSpan={totalCols} className="p-0">
            <div ref={parentRef} className="max-h-[640px] overflow-auto">
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((vi) => {
                  const t = tasksToShow[vi.index];
                  if (!t) return null;
                  return (
                    <VirtualRow
                      key={t.id}
                      task={t}
                      projectId={projectId}
                      columns={columns}
                      fieldCols={fieldCols}
                      selected={selectionSet.has(t.id)}
                      onToggleSelect={onToggleSelect}
                      onShiftRange={onShiftRange}
                      onSelect={onSelect}
                      top={vi.start}
                    />
                  );
                })}
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onClick,
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onClick: (k: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ChevronUp : ChevronDown) : ChevronsUpDown;
  return (
    <th
      className="px-3 py-2"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onClick(sortKey)}
        className="flex items-center gap-1 text-xs uppercase tracking-wide text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:text-ink"
      >
        {label}
        <Icon
          className={cn('h-3 w-3', active ? 'text-ink' : 'text-ink-disabled')}
          aria-hidden
        />
      </button>
    </th>
  );
}

function EditableRow({
  task,
  projectId,
  columns,
  fieldCols,
  selected,
  onToggleSelect,
  onShiftRange,
  onSelect,
}: {
  task: TaskWithPeople;
  projectId: string;
  columns: ListColumn[];
  fieldCols: FieldCols;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onShiftRange: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <tr
      className={cn(
        'border-t border-line hover:bg-bg-subtle',
        selected && 'bg-brand-50/40',
      )}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          onShiftRange(task.id);
        }
      }}
    >
      <td className="px-3 py-2 align-middle">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(task.id)}
          aria-label={`Select task ${task.title}`}
          onClick={(e) => e.stopPropagation()}
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <InlineTitle task={task} onOpen={() => onSelect(task.id)} />
      </td>
      {columns.includes('status') ? (
        <td className="px-3 py-2 align-middle">
          <InlineStatus task={task} />
        </td>
      ) : null}
      {columns.includes('priority') ? (
        <td className="px-3 py-2 align-middle">
          <InlinePriority task={task} />
        </td>
      ) : null}
      {columns.includes('assignee') ? (
        <td className="px-3 py-2 align-middle">
          <InlineAssignee task={task} projectId={projectId} />
        </td>
      ) : null}
      {columns.includes('due') ? (
        <td className="px-3 py-2 align-middle">
          <InlineDue task={task} />
        </td>
      ) : null}
      {columns.includes('updated') ? (
        <td className="px-3 py-2 align-middle">
          <Tooltip content={absoluteTime(task.updatedAt)}>
            <span className="text-xs text-ink-muted">{relativeTime(task.updatedAt)}</span>
          </Tooltip>
        </td>
      ) : null}
      {columns.includes('description') ? (
        <td className="max-w-xs truncate px-3 py-2 align-middle text-xs text-ink-muted">
          {task.description ?? '-'}
        </td>
      ) : null}
      {columns.includes('sprint') ? (
        <td className="px-3 py-2 align-middle">
          <SprintCell task={task} projectId={projectId} />
        </td>
      ) : null}
      {columns.includes('estimate') ? (
        <td className="px-3 py-2 align-middle">
          <span className="text-xs text-ink">
            {task.estimateHours ? `${task.estimateHours}h` : '-'}
          </span>
        </td>
      ) : null}
      {fieldCols.fields.map((f) => (
        <td key={f.column} className="max-w-xs truncate px-3 py-2 align-middle text-xs text-ink">
          {fieldCols.textFor(task.id, f.definition) || <span className="text-ink-disabled">-</span>}
        </td>
      ))}
    </tr>
  );
}

function VirtualRow(props: {
  task: TaskWithPeople;
  projectId: string;
  columns: ListColumn[];
  fieldCols: FieldCols;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onShiftRange: (id: string) => void;
  onSelect: (id: string) => void;
  top: number;
}) {
  const { task, columns, fieldCols, selected, onToggleSelect, onShiftRange, onSelect, top } = props;
  const cellCount =
    columns.filter((c) => customFieldIdOf(c) === null).length + fieldCols.fields.length;
  return (
    <div
      role="row"
      className={cn(
        'absolute left-0 right-0 grid items-center gap-2 border-t border-line px-3 hover:bg-bg-subtle',
        selected && 'bg-brand-50/40',
      )}
      style={{
        transform: `translateY(${top}px)`,
        gridTemplateColumns: '40px minmax(0, 2fr)' + ' minmax(0, 1fr)'.repeat(cellCount),
        height: ROW_HEIGHT,
      }}
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          onShiftRange(task.id);
        }
      }}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggleSelect(task.id)}
        aria-label={`Select ${task.title}`}
      />
      <button
        type="button"
        onClick={() => onSelect(task.id)}
        className="truncate text-left text-sm font-medium text-ink hover:text-brand-700"
      >
        {task.title}
      </button>
      {columns.includes('status') ? <StatusBadge status={task.status} /> : null}
      {columns.includes('priority') ? <PriorityBadge priority={task.priority} /> : null}
      {columns.includes('assignee') ? <CellAssigneeReadOnly task={task} /> : null}
      {columns.includes('due') ? (
        task.dueDate ? (
          <DueDisplay value={task.dueDate} />
        ) : (
          <span className="text-ink-disabled">-</span>
        )
      ) : null}
      {columns.includes('updated') ? (
        <Tooltip content={absoluteTime(task.updatedAt)}>
          <span className="text-xs text-ink-muted truncate">{relativeTime(task.updatedAt)}</span>
        </Tooltip>
      ) : null}
      {columns.includes('description') ? (
        <span className="truncate text-xs text-ink-muted">{task.description ?? '-'}</span>
      ) : null}
      {columns.includes('sprint') ? <span className="truncate text-xs text-ink-muted">-</span> : null}
      {columns.includes('estimate') ? (
        <span className="text-xs text-ink">
          {task.estimateHours ? `${task.estimateHours}h` : '-'}
        </span>
      ) : null}
      {fieldCols.fields.map((f) => (
        <span key={f.column} className="truncate text-xs text-ink">
          {fieldCols.textFor(task.id, f.definition) || '-'}
        </span>
      ))}
    </div>
  );
}

// ---- Inline editors ----

function InlineTitle({ task, onOpen }: { task: TaskWithPeople; onOpen: () => void }) {
  const update = useUpdateTask();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  useEffect(() => setValue(task.title), [task.title]);
  if (!editing) {
    return (
      <button
        type="button"
        onClick={onOpen}
        onDoubleClick={(e) => {
          e.preventDefault();
          setEditing(true);
        }}
        className="text-left text-sm font-medium text-ink hover:text-brand-700 focus-visible:outline-none focus-visible:text-brand-700"
      >
        {task.title}
      </button>
    );
  }
  return (
    <Input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const t = value.trim();
        if (t && t !== task.title) update.mutate({ id: task.id, input: { title: t } });
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setValue(task.title);
          setEditing(false);
        }
      }}
      className="h-8 text-sm"
    />
  );
}

function InlineStatus({ task }: { task: TaskWithPeople }) {
  const update = useUpdateTask();
  return (
    <Select
      value={task.status}
      onValueChange={(v) =>
        update.mutate({ id: task.id, input: { status: v as UpdateTaskInput['status'] } })
      }
    >
      <SelectTrigger
        className="h-8 w-fit min-w-[140px] border-transparent shadow-none bg-transparent hover:bg-bg-subtle text-xs"
        aria-label={`Change status (currently ${statusLabel(task.status)})`}
      >
        <SelectValue>
          <StatusBadge status={task.status} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((s) => (
          <SelectItem key={s} value={s}>
            {statusLabel(s)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InlinePriority({ task }: { task: TaskWithPeople }) {
  const update = useUpdateTask();
  return (
    <Select
      value={task.priority}
      onValueChange={(v) =>
        update.mutate({ id: task.id, input: { priority: v as UpdateTaskInput['priority'] } })
      }
    >
      <SelectTrigger
        className="h-8 w-fit min-w-[120px] border-transparent shadow-none bg-transparent hover:bg-bg-subtle text-xs"
        aria-label={`Change priority (currently ${priorityLabel(task.priority)})`}
      >
        <SelectValue>
          <PriorityBadge priority={task.priority} />
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PRIORITY_OPTIONS.map((p) => (
          <SelectItem key={p} value={p}>
            {priorityLabel(p)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InlineAssignee({ task, projectId }: { task: TaskWithPeople; projectId: string }) {
  const update = useUpdateTask();
  return (
    <div className="min-w-[180px]">
      <WorkspaceMembersCombobox
        value={task.assigneeId}
        onChange={(userId) => update.mutate({ id: task.id, input: { assigneeId: userId } })}
        projectId={projectId}
        placeholder="Unassigned"
      />
    </div>
  );
}

function InlineDue({ task }: { task: TaskWithPeople }) {
  const update = useUpdateTask();
  return (
    <div className="min-w-[140px]">
      <DatePicker
        value={task.dueDate}
        onChange={(d) => update.mutate({ id: task.id, input: { dueDate: d } })}
        placeholder="-"
        size="sm"
      />
    </div>
  );
}

function SprintCell({ task, projectId }: { task: TaskWithPeople; projectId: string }) {
  const { data: sprints } = useSprints(projectId);
  const sprint = sprints?.find((s) => s.taskIds.includes(task.id));
  return (
    <span className="text-xs text-ink truncate">
      {sprint ? sprint.name : <span className="text-ink-disabled">-</span>}
    </span>
  );
}

function CellAssigneeReadOnly({ task }: { task: TaskWithPeople }) {
  if (!task.assignee) {
    return <span className="text-xs text-ink-disabled">Unassigned</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <UserAvatar
        size="sm"
        name={task.assignee.name || task.assignee.email}
        image={task.assignee.image}
      />
      <span className="truncate text-sm text-ink">
        {task.assignee.name || task.assignee.email}
      </span>
    </div>
  );
}

function DueDisplay({ value }: { value: Date }) {
  const overdue = isOverdue(value);
  return (
    <Tooltip content={absoluteTime(value)}>
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs',
          overdue ? 'text-state-error font-medium' : 'text-ink',
        )}
      >
        {overdue ? <AlertTriangle className="h-3 w-3" aria-hidden /> : null}
        {relativeTime(value)}
      </span>
    </Tooltip>
  );
}

function CardListGroup({
  group,
  collapsed,
  onToggle,
  onSelect,
}: {
  group: Group;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-2 bg-bg-subtle px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-muted hover:text-ink"
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span>{group.label}</span>
          <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-mono">
            {group.tasks.length}
          </span>
        </span>
      </button>
      {!collapsed ? (
        <ul className="divide-y divide-line">
          {group.tasks.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="flex w-full flex-col gap-2 p-3 text-left hover:bg-bg-subtle"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{t.title}</span>
                  <StatusBadge status={t.status} />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <PriorityBadge priority={t.priority} />
                  {t.assignee ? (
                    <UserAvatar
                      size="sm"
                      name={t.assignee.name || t.assignee.email}
                      image={t.assignee.image}
                    />
                  ) : (
                    <span className="text-xs text-ink-disabled">Unassigned</span>
                  )}
                </div>
                {t.dueDate ? <DueDisplay value={t.dueDate} /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
