'use client';

import {
  Check,
  Columns3,
  Download,
  Filter as FilterIcon,
  GripVertical,
  LayoutGrid,
  Layers,
  Search,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { TaskPriority, TaskStatus } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UserAvatar } from '@/components/ui/avatar';
import { WorkspaceMembersCombobox } from '@/components/workspace/workspace-members-combobox';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { useDebouncedCallback } from '@/hooks/use-debounced';
import type { BoardDensity, BoardGroupBy, ListColumn, ListGroupBy } from '@/hooks/use-board-prefs';
import { ALL_LIST_COLUMNS, customFieldColumn } from '@/hooks/use-board-prefs';
import { useCustomFieldDefinitions } from '@/hooks/use-custom-fields';
import { SavedViewsMenu, type ViewSnapshot } from '@/components/projects/views/saved-views-menu';
import { hasActiveFilters, type DueDatePreset, type TaskFilters } from '@/hooks/use-task-filters';
import { cn } from '@/lib/utils';

interface BaseProps {
  projectId: string;
  filters: TaskFilters;
  onChangeFilters: (next: TaskFilters) => void;
  onClearFilters: () => void;
}

export interface BoardToolbarProps extends BaseProps {
  variant: 'board';
  density: BoardDensity;
  onChangeDensity: (next: BoardDensity) => void;
  groupBy: BoardGroupBy;
  onChangeGroupBy: (next: BoardGroupBy) => void;
  onApplySavedView: (config: ViewSnapshot | null) => void;
  snapshot: ViewSnapshot;
}

export interface ListToolbarProps extends BaseProps {
  variant: 'list';
  groupBy: ListGroupBy;
  onChangeGroupBy: (next: ListGroupBy) => void;
  columns: ListColumn[];
  onChangeColumns: (next: ListColumn[]) => void;
  onExportCsv: () => void;
  onApplySavedView: (config: ViewSnapshot | null) => void;
  snapshot: ViewSnapshot;
}

export type TaskToolbarProps = BoardToolbarProps | ListToolbarProps;

export function TaskToolbar(props: TaskToolbarProps) {
  const { projectId, filters, onChangeFilters, onClearFilters } = props;
  const [searchLocal, setSearchLocal] = useState(filters.search);
  const debouncedSearch = useDebouncedCallback((v: string) => {
    onChangeFilters({ ...filters, search: v });
  }, 200);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Search
            className="text-ink-disabled absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search tasks…"
            aria-label="Search tasks by title"
            className="pl-8"
            value={searchLocal}
            onChange={(e) => {
              setSearchLocal(e.target.value);
              debouncedSearch(e.target.value);
            }}
          />
        </div>

        <FilterChipsButton projectId={projectId} filters={filters} onChange={onChangeFilters} />

        {hasActiveFilters(filters) ? (
          <Button size="sm" variant="ghost" onClick={onClearFilters} aria-label="Clear filters">
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {props.variant === 'board' ? (
            <BoardControls
              density={props.density}
              onChangeDensity={props.onChangeDensity}
              groupBy={props.groupBy}
              onChangeGroupBy={props.onChangeGroupBy}
            />
          ) : (
            <ListControls
              projectId={projectId}
              groupBy={props.groupBy}
              onChangeGroupBy={props.onChangeGroupBy}
              columns={props.columns}
              onChangeColumns={props.onChangeColumns}
              onExportCsv={props.onExportCsv}
            />
          )}

          <SavedViewsMenu
            projectId={projectId}
            snapshot={props.snapshot}
            onApply={(view) => {
              if (!view) {
                onClearFilters();
                props.onApplySavedView(null);
                return;
              }
              const f = view.config.filter ?? {};
              onChangeFilters({
                search: f.search ?? '',
                status: f.status ?? [],
                priority: f.priority ?? [],
                assigneeIds: f.assigneeIds ?? [],
                dueDate: 'all',
              });
              props.onApplySavedView({
                viewType: props.variant,
                filter: view.config.filter,
                columns: view.config.columns,
                groupBy: view.config.groupBy,
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function BoardControls({
  density,
  onChangeDensity,
  groupBy,
  onChangeGroupBy,
}: {
  density: BoardDensity;
  onChangeDensity: (n: BoardDensity) => void;
  groupBy: BoardGroupBy;
  onChangeGroupBy: (n: BoardGroupBy) => void;
}) {
  return (
    <>
      <Select value={groupBy} onValueChange={(v) => onChangeGroupBy(v as BoardGroupBy)}>
        <SelectTrigger className="h-8 w-fit min-w-[140px] text-xs" aria-label="Group by">
          <span className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No grouping</SelectItem>
          <SelectItem value="assignee">By assignee</SelectItem>
          <SelectItem value="priority">By priority</SelectItem>
          <SelectItem value="epic">By epic</SelectItem>
        </SelectContent>
      </Select>
      <Select value={density} onValueChange={(v) => onChangeDensity(v as BoardDensity)}>
        <SelectTrigger className="h-8 w-fit min-w-[120px] text-xs" aria-label="Card density">
          <span className="flex items-center gap-1.5">
            <LayoutGrid className="h-3.5 w-3.5" />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="normal">Normal</SelectItem>
          <SelectItem value="detailed">Detailed</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}

function ListControls({
  projectId,
  groupBy,
  onChangeGroupBy,
  columns,
  onChangeColumns,
  onExportCsv,
}: {
  projectId: string;
  groupBy: ListGroupBy;
  onChangeGroupBy: (n: ListGroupBy) => void;
  columns: ListColumn[];
  onChangeColumns: (n: ListColumn[]) => void;
  onExportCsv: () => void;
}) {
  return (
    <>
      <Select value={groupBy} onValueChange={(v) => onChangeGroupBy(v as ListGroupBy)}>
        <SelectTrigger className="h-8 w-fit min-w-[140px] text-xs" aria-label="Group by">
          <span className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No grouping</SelectItem>
          <SelectItem value="status">By status</SelectItem>
          <SelectItem value="assignee">By assignee</SelectItem>
          <SelectItem value="priority">By priority</SelectItem>
          <SelectItem value="sprint">By sprint</SelectItem>
        </SelectContent>
      </Select>

      <ColumnPickerPopover projectId={projectId} columns={columns} onChange={onChangeColumns} />

      <Button variant="outline" size="sm" onClick={onExportCsv}>
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </Button>
    </>
  );
}

function ColumnPickerPopover({
  projectId,
  columns,
  onChange,
}: {
  projectId: string;
  columns: ListColumn[];
  onChange: (next: ListColumn[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dragId, setDragId] = useState<ListColumn | null>(null);
  // The project's task custom fields are optional columns too.
  const fieldDefs = useCustomFieldDefinitions({ scope: 'TASK', projectId });
  const allColumns: { id: ListColumn; label: string }[] = [
    ...ALL_LIST_COLUMNS,
    ...(fieldDefs.data ?? [])
      .filter((d) => d.scope === 'TASK' && d.projectId === projectId)
      .sort((a, b) => a.position - b.position)
      .map((d) => ({ id: customFieldColumn(d.id), label: d.name })),
  ];

  const ordered: { id: ListColumn; label: string; visible: boolean }[] = [];
  // Visible (in order)
  for (const id of columns) {
    const meta = allColumns.find((c) => c.id === id);
    if (meta) ordered.push({ id, label: meta.label, visible: true });
  }
  // Then the rest (hidden)
  for (const meta of allColumns) {
    if (!columns.includes(meta.id)) {
      ordered.push({ id: meta.id, label: meta.label, visible: false });
    }
  }

  const toggle = (id: ListColumn) => {
    if (columns.includes(id)) {
      onChange(columns.filter((c) => c !== id));
    } else {
      onChange([...columns, id]);
    }
  };

  const handleDrop = (target: ListColumn) => {
    if (!dragId || dragId === target) {
      setDragId(null);
      return;
    }
    const next = ordered
      .filter((o) => o.visible || o.id === dragId || o.id === target)
      .map((o) => o.id);
    const moving = next.filter((id) => id !== dragId);
    const tIdx = moving.indexOf(target);
    const inserted = [...moving.slice(0, tIdx), dragId, ...moving.slice(tIdx)];
    // Only keep visible ones (those that were visible before plus the dragged one).
    const visibleSet = new Set<ListColumn>(columns);
    visibleSet.add(dragId);
    onChange(inserted.filter((id) => visibleSet.has(id)));
    setDragId(null);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Columns3 className="h-3.5 w-3.5" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="text-ink-muted px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-wide">
          Visible columns
        </p>
        <ul role="listbox" aria-label="Visible columns" className="space-y-0.5">
          {ordered.map((col) => (
            <li
              key={col.id}
              draggable={col.visible}
              onDragStart={() => col.visible && setDragId(col.id)}
              onDragOver={(e) => {
                if (col.visible) e.preventDefault();
              }}
              onDrop={() => col.visible && handleDrop(col.id)}
              className={cn(
                'flex items-center gap-2 rounded px-2 py-1.5 text-sm',
                col.visible ? 'hover:bg-bg-subtle' : 'hover:bg-bg-subtle opacity-60',
                dragId === col.id && 'opacity-50',
              )}
            >
              <span aria-hidden className={cn('cursor-grab', !col.visible && 'invisible')}>
                <GripVertical className="text-ink-disabled h-3.5 w-3.5" />
              </span>
              <Checkbox
                checked={col.visible}
                onCheckedChange={() => toggle(col.id)}
                aria-label={col.visible ? `Hide ${col.label}` : `Show ${col.label}`}
              />
              <span className="flex-1">{col.label}</span>
              {col.visible ? <Check className="text-brand-600 h-3 w-3" aria-hidden /> : null}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

const DUE_DATE_OPTIONS: { id: DueDatePreset; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'this_week', label: 'This week' },
  { id: 'next_14_days', label: 'Next 14d' },
  { id: 'no_date', label: 'No date' },
];

function FilterChipsButton({
  projectId,
  filters,
  onChange,
}: {
  projectId: string;
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState('');
  const membersQuery = useWorkspaceMembers(projectId);
  const members = membersQuery.data ?? [];

  const activeCount =
    filters.status.length +
    filters.priority.length +
    filters.assigneeIds.length +
    (filters.dueDate && filters.dueDate !== 'all' ? 1 : 0);

  const filteredMembers = members.filter(
    (m) =>
      !assigneeSearch.trim() ||
      m.user.name?.toLowerCase().includes(assigneeSearch.toLowerCase()) ||
      m.user.email.toLowerCase().includes(assigneeSearch.toLowerCase()),
  );

  const toggleAssignee = (userId: string) => {
    const next = filters.assigneeIds.includes(userId)
      ? filters.assigneeIds.filter((id) => id !== userId)
      : [...filters.assigneeIds, userId];
    onChange({ ...filters, assigneeIds: next });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <FilterIcon className="h-3.5 w-3.5" />
          Filter
          {activeCount > 0 ? (
            <span className="bg-brand-100 text-brand-700 rounded-full px-1.5 text-[10px] font-semibold">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-3.5">
          {/* Due date filter */}
          <FilterSection label="Due date">
            <div className="flex flex-wrap gap-1.5">
              {DUE_DATE_OPTIONS.map((d) => {
                const active = (filters.dueDate || 'all') === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange({
                        ...filters,
                        dueDate: d.id,
                      })
                    }
                    className={cn(
                      'whitespace-nowrap rounded-full border px-2 py-0.5 text-xs transition-colors',
                      active
                        ? d.id === 'overdue'
                          ? 'border-state-error bg-state-error/10 text-state-error font-medium'
                          : 'border-brand-purple bg-brand-50 text-brand-700 font-medium'
                        : 'border-line text-ink-muted hover:bg-bg-subtle',
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          {/* Status filter */}
          <FilterSection label="Status">
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((s) => {
                const active = filters.status.includes(s);
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange({
                        ...filters,
                        status: active
                          ? filters.status.filter((x) => x !== s)
                          : [...filters.status, s as TaskStatus],
                      })
                    }
                    className={cn(
                      'whitespace-nowrap rounded-full border px-2 py-0.5 text-xs',
                      active
                        ? 'border-brand-purple bg-brand-50 text-brand-700'
                        : 'border-line hover:bg-bg-subtle',
                    )}
                  >
                    {statusLabel(s)}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          {/* Priority filter */}
          <FilterSection label="Priority">
            <div className="flex flex-wrap gap-1.5">
              {PRIORITY_OPTIONS.map((p) => {
                const active = filters.priority.includes(p);
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange({
                        ...filters,
                        priority: active
                          ? filters.priority.filter((x) => x !== p)
                          : [...filters.priority, p as TaskPriority],
                      })
                    }
                    className={cn(
                      'whitespace-nowrap rounded-full border px-2 py-0.5 text-xs',
                      active
                        ? 'border-brand-purple bg-brand-50 text-brand-700'
                        : 'border-line hover:bg-bg-subtle',
                    )}
                  >
                    {priorityLabel(p)}
                  </button>
                );
              })}
            </div>
          </FilterSection>

          {/* Multi-Assignee filter */}
          <FilterSection label="Assignees">
            <div className="mb-2 flex items-center justify-between gap-1 text-[11px]">
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => onChange({ ...filters, assigneeIds: [] })}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    filters.assigneeIds.length === 0
                      ? 'bg-brand-50 text-brand-700 font-semibold'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  All
                </button>
                <button
                  type="button"
                  onClick={() => toggleAssignee('__unassigned__')}
                  className={cn(
                    'rounded px-1.5 py-0.5 transition-colors',
                    filters.assigneeIds.includes('__unassigned__')
                      ? 'bg-brand-50 text-brand-700 font-semibold'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  Unassigned
                </button>
              </div>
              {filters.assigneeIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => onChange({ ...filters, assigneeIds: [] })}
                  className="text-ink-muted hover:underline"
                >
                  Reset ({filters.assigneeIds.length})
                </button>
              ) : null}
            </div>

            {members.length > 5 ? (
              <Input
                type="search"
                placeholder="Search assignees…"
                value={assigneeSearch}
                onChange={(e) => setAssigneeSearch(e.target.value)}
                className="mb-1.5 h-7 text-xs"
              />
            ) : null}

            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {filteredMembers.map((m) => {
                const checked = filters.assigneeIds.includes(m.userId);
                return (
                  <label
                    key={m.userId}
                    className={cn(
                      'hover:bg-bg-subtle flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs',
                      checked && 'bg-brand-50/50',
                    )}
                  >
                    <Checkbox checked={checked} onCheckedChange={() => toggleAssignee(m.userId)} />
                    <UserAvatar size="xs" name={m.user.name || m.user.email} image={m.user.image} />
                    <span className="text-ink truncate">{m.user.name || m.user.email}</span>
                  </label>
                );
              })}
            </div>
          </FilterSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-ink-muted text-[10px] font-semibold uppercase tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}
