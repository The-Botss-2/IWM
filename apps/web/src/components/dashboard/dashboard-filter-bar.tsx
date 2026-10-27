'use client';

import {
  AlertTriangle,
  Building2,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  Filter,
  Search,
  SlidersHorizontal,
  User,
  Users,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TaskDateField, TaskPriority, TaskStatus, TaskWithPeople } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import {
  PRIORITY_OPTIONS,
  STATUS_OPTIONS,
  priorityLabel,
  statusLabel,
} from '@/components/tasks/task-badges';
import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { DateRangePicker } from '@/components/ui/date-range-picker';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  activeDashboardFilterCount,
  hasActiveDashboardFilters,
  useDashboardFilters,
  type DueDatePreset,
} from '@/hooks/use-dashboard-filters';
import {
  useDashboardAssigneeOptions,
  useDashboardAssigneesLoading,
  type AssigneeOption,
} from '@/hooks/use-dashboard-assignee-options';
import { useDashboardOverviewTasks } from '@/hooks/use-dashboard-overview-tasks';
import { activeDayRange } from '@/lib/dashboard-filters';
import { formatDayRange, type DayRange } from '@/lib/date-range';
import { useWorkspaces } from '@/hooks/use-workspace';
import { cn } from '@/lib/utils';

export type { AssigneeOption };

interface DashboardFilterBarProps {
  /**
   * Whether the Work Overview widget is on screen. When it is, the bar also
   * offers the overview tasks' assignees (shared cached query); when it is
   * hidden the bar doesn't trigger that fetch on its own.
   */
  overviewTasksEnabled?: boolean;
  className?: string;
}

export function DashboardFilterBar({ overviewTasksEnabled = true, className }: DashboardFilterBarProps) {
  const session = useSessionContext();
  const currentUserId = session.data?.user?.id ?? '';
  const filters = useDashboardFilters();
  const {
    workspaceId,
    status,
    priority,
    assigneeIds,
    duePreset,
    search,
    dateField,
    setWorkspaceId,
    toggleStatus,
    setStatus,
    togglePriority,
    setPriority,
    toggleAssigneeId,
    setAssigneeIds,
    setDuePreset,
    setSearch,
    setDateField,
    setDateRange,
    resetFilters,
  } = filters;
  const dayRange = activeDayRange(filters);

  const hasActive = hasActiveDashboardFilters(filters);
  const activeCount = activeDashboardFilterCount(filters);

  // Fetch all workspaces in the caller's organization
  const workspacesQuery = useWorkspaces();
  const workspaceItems = workspacesQuery.data?.items ?? [];

  // Workspace members plus every assignee seen on the overview tasks
  const overviewTasks = useDashboardOverviewTasks({ enabled: overviewTasksEnabled });
  // Skip placeholder rows (keepPreviousData): after a workspace change they
  // still belong to the previous workspace and would seed its assignees into
  // the new list.
  const tasks = useMemo<TaskWithPeople[]>(
    () =>
      overviewTasksEnabled && !overviewTasks.isPlaceholderData
        ? overviewTasks.data?.items ?? []
        : [],
    [overviewTasksEnabled, overviewTasks.data, overviewTasks.isPlaceholderData],
  );
  const allAssignees = useDashboardAssigneeOptions(tasks, workspaceId);
  // Chip names come from members AND overview tasks, so both count as
  // loading. The `overviewTasksEnabled` guard matters: a disabled query with
  // no data stays `isPending` forever, which would pin the chip on "Loading…".
  const assigneesLoading =
    useDashboardAssigneesLoading() ||
    (overviewTasksEnabled && (overviewTasks.isPending || overviewTasks.isPlaceholderData));

  const activeWorkspace = workspaceItems.find((w) => w.id === workspaceId);

  return (
    <div
      className={cn(
        'rounded-xl border border-line bg-white/95 p-3.5 shadow-soft backdrop-blur-sm transition-all',
        className,
      )}
    >
      {/* Primary Toolbar Row */}
      <div className="flex flex-wrap items-center gap-2.5">
        {/* Search input */}
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-disabled"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Filter tasks, projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 pr-3 text-xs"
            aria-label="Filter tasks"
          />
        </div>

        {/* Workspace selector dropdown */}
        <WorkspaceDropdown
          workspaces={workspaceItems}
          selectedWorkspaceId={workspaceId}
          onSelectWorkspace={setWorkspaceId}
        />

        {/* Due Dates filter */}
        <DueDateDropdown selected={duePreset} onSelect={setDuePreset} />

        {/* Date range on the due, created or completed date */}
        <DateRangeFilter
          range={dayRange}
          field={dateField}
          onRangeChange={setDateRange}
          onFieldChange={setDateField}
        />

        {/* Status filter */}
        <StatusDropdown
          selected={status}
          onToggle={toggleStatus}
          onSelectAllOpen={() =>
            setStatus(['BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW'])
          }
          onClear={() => setStatus([])}
        />

        {/* Assignees Multi-select */}
        <AssigneeMultiSelect
          assignees={allAssignees}
          selectedIds={assigneeIds}
          currentUserId={currentUserId}
          onToggle={toggleAssigneeId}
          onSetIds={setAssigneeIds}
        />

        {/* Priority filter */}
        <PriorityDropdown
          selected={priority}
          onToggle={togglePriority}
          onClear={() => setPriority([])}
        />

        {/* Reset all button */}
        {hasActive ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            className="h-9 gap-1.5 px-2.5 text-xs text-state-error hover:bg-state-error/10 hover:text-state-error"
          >
            <X className="h-3.5 w-3.5" />
            Clear all ({activeCount})
          </Button>
        ) : null}
      </div>

      {/* Active filter chips pill strip */}
      {hasActive ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2.5 text-xs">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">
            Filtered by:
          </span>

          {workspaceId ? (
            <FilterChip
              label={`Workspace: ${activeWorkspace?.name ?? 'Selected'}`}
              onRemove={() => setWorkspaceId(null)}
            />
          ) : (
            <FilterChip
              label="All Workspaces (Org-wide)"
              variant="subtle"
            />
          )}

          {duePreset !== 'all' ? (
            <FilterChip
              label={`Due: ${formatDueLabel(duePreset)}`}
              onRemove={() => setDuePreset('all')}
              highlight={duePreset === 'overdue'}
            />
          ) : null}

          {dayRange ? (
            <FilterChip
              label={`${DATE_FIELD_LABEL[dateField]}: ${formatDayRange(dayRange)}`}
              onRemove={() => setDateRange(null)}
            />
          ) : null}

          {status.map((s) => (
            <FilterChip
              key={s}
              label={statusLabel(s)}
              onRemove={() => toggleStatus(s)}
            />
          ))}

          {assigneeIds.map((id) => {
            if (id === '__unassigned__') {
              return (
                <FilterChip
                  key={id}
                  label="Unassigned"
                  onRemove={() => toggleAssigneeId(id)}
                />
              );
            }
            if (id === '__assigned_to_me__') {
              return (
                <FilterChip
                  key={id}
                  label="Assigned to Me"
                  onRemove={() => toggleAssigneeId(id)}
                />
              );
            }
            const person = allAssignees.find((a) => a.id === id);
            return (
              <FilterChip
                key={id}
                // A saved view or URL can name someone no longer in the
                // member list; never fall back to printing their id.
                label={`Assignee: ${person?.name ?? (assigneesLoading ? 'Loading…' : 'Unknown member')}`}
                onRemove={() => toggleAssigneeId(id)}
              />
            );
          })}

          {priority.map((p) => (
            <FilterChip
              key={p}
              label={`Priority: ${priorityLabel(p)}`}
              onRemove={() => togglePriority(p)}
            />
          ))}

          {search.trim() ? (
            <FilterChip
              label={`Search: "${search}"`}
              onRemove={() => setSearch('')}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------
// Workspace Dropdown Component
// -------------------------------------------------------------
function WorkspaceDropdown({
  workspaces,
  selectedWorkspaceId,
  onSelectWorkspace,
}: {
  workspaces: Array<{ id: string; name: string }>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedName = selectedWorkspaceId
    ? workspaces.find((w) => w.id === selectedWorkspaceId)?.name ?? 'Workspace'
    : 'All Workspaces';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            selectedWorkspaceId && 'border-brand-purple/40 bg-brand-50/50 text-brand-700 font-medium',
          )}
        >
          <Building2 className="h-3.5 w-3.5 text-ink-muted" />
          <span className="max-w-[130px] truncate">{selectedName}</span>
          <ChevronDown className="h-3 w-3 text-ink-disabled" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Filter by Workspace
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => {
              onSelectWorkspace(null);
              setOpen(false);
            }}
            className={cn(
              'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition-colors',
              selectedWorkspaceId === null
                ? 'bg-brand-50 font-medium text-brand-700'
                : 'text-ink hover:bg-bg-subtle',
            )}
          >
            <span>All workspaces (Org-wide)</span>
            {selectedWorkspaceId === null ? <Check className="h-3.5 w-3.5" /> : null}
          </button>
          <div className="my-1 border-t border-line/60" />
          {workspaces.map((w) => {
            const active = selectedWorkspaceId === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => {
                  onSelectWorkspace(w.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition-colors',
                  active
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-ink hover:bg-bg-subtle',
                )}
              >
                <span className="truncate">{w.name}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Due Date Dropdown Component
// -------------------------------------------------------------
function DueDateDropdown({
  selected,
  onSelect,
}: {
  selected: DueDatePreset;
  onSelect: (preset: DueDatePreset) => void;
}) {
  const [open, setOpen] = useState(false);

  const options: { id: DueDatePreset; label: string; icon?: string; badgeClass?: string }[] = [
    { id: 'all', label: 'All Due Dates' },
    { id: 'overdue', label: 'Overdue', badgeClass: 'text-state-error font-medium' },
    { id: 'today', label: 'Due Today', badgeClass: 'text-brand-orange font-medium' },
    { id: 'tomorrow', label: 'Due Tomorrow' },
    { id: 'this_week', label: 'Due This Week (7d)' },
    { id: 'next_14_days', label: 'Due Next 14 Days' },
    { id: 'no_date', label: 'No Due Date' },
  ];

  const current = options.find((o) => o.id === selected);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            selected !== 'all' && 'border-brand-purple/40 bg-brand-50/50 text-brand-700 font-medium',
            selected === 'overdue' && 'border-state-error/40 bg-state-error/10 text-state-error',
          )}
        >
          <Calendar className="h-3.5 w-3.5 text-ink-muted" />
          <span>{current?.label ?? 'Due Date'}</span>
          <ChevronDown className="h-3 w-3 text-ink-disabled" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1">
        <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          Due Date Range
        </div>
        <div className="space-y-0.5">
          {options.map((opt) => {
            const active = selected === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onSelect(opt.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition-colors',
                  active
                    ? 'bg-brand-50 font-medium text-brand-700'
                    : 'text-ink hover:bg-bg-subtle',
                  opt.badgeClass,
                )}
              >
                <span>{opt.label}</span>
                {active ? <Check className="h-3.5 w-3.5" /> : null}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Date Range Filter (start / end day on a chosen task date)
// -------------------------------------------------------------
const DATE_FIELD_LABEL: Record<TaskDateField, string> = {
  due: 'Due',
  created: 'Created',
  completed: 'Completed',
};
const DATE_FIELDS: readonly TaskDateField[] = ['due', 'created', 'completed'];

function DateRangeFilter({
  range,
  field,
  onRangeChange,
  onFieldChange,
}: {
  range: DayRange | null;
  field: TaskDateField;
  onRangeChange: (range: DayRange | null) => void;
  onFieldChange: (field: TaskDateField) => void;
}) {
  return (
    <DateRangePicker
      value={range}
      onChange={onRangeChange}
      label={range ? `${DATE_FIELD_LABEL[field]}: ${formatDayRange(range)}` : undefined}
      placeholder="Date range"
      header={
        <div>
          <p className="px-0.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
            Filter tasks by
          </p>
          <div
            className="grid grid-cols-3 gap-0.5 rounded-lg border border-line p-0.5"
            role="radiogroup"
            aria-label="Date to filter on"
          >
            {DATE_FIELDS.map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={field === f}
                onClick={() => onFieldChange(f)}
                className={cn(
                  'whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  field === f ? 'bg-brand-50 text-brand-700 shadow-sm' : 'text-ink-muted hover:text-ink',
                )}
              >
                {DATE_FIELD_LABEL[f]}
              </button>
            ))}
          </div>
        </div>
      }
    />
  );
}

// -------------------------------------------------------------
// Status Dropdown Component
// -------------------------------------------------------------
function StatusDropdown({
  selected,
  onToggle,
  onSelectAllOpen,
  onClear,
}: {
  selected: TaskStatus[];
  onToggle: (s: TaskStatus) => void;
  onSelectAllOpen: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            selected.length > 0 && 'border-brand-purple/40 bg-brand-50/50 text-brand-700 font-medium',
          )}
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-ink-muted" />
          <span>
            Status
            {selected.length > 0 ? ` (${selected.length})` : ''}
          </span>
          <ChevronDown className="h-3 w-3 text-ink-disabled" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <div className="flex items-center justify-between pb-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">
            Filter Status
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSelectAllOpen}
              className="text-brand-600 hover:underline"
            >
              Open
            </button>
            {selected.length > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className="text-ink-muted hover:underline"
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>

        <div className="space-y-1 pt-1">
          {STATUS_OPTIONS.map((s) => {
            const active = selected.includes(s);
            return (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-bg-subtle"
              >
                <Checkbox
                  checked={active}
                  onCheckedChange={() => onToggle(s)}
                />
                <span className="flex-1 text-ink">{statusLabel(s)}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Assignee Multi-Select Component (Individual or Multiple at Once)
// -------------------------------------------------------------
export function AssigneeMultiSelect({
  assignees,
  selectedIds,
  currentUserId,
  onToggle,
  onSetIds,
}: {
  assignees: AssigneeOption[];
  selectedIds: string[];
  currentUserId: string;
  onToggle: (id: string) => void;
  onSetIds: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filteredAssignees = useMemo(() => {
    if (!search.trim()) return assignees;
    const needle = search.toLowerCase();
    return assignees.filter(
      (a) =>
        a.name.toLowerCase().includes(needle) ||
        a.email.toLowerCase().includes(needle),
    );
  }, [assignees, search]);

  // Label for trigger button
  const triggerLabel = useMemo(() => {
    if (selectedIds.length === 0) return 'Assignee: All';
    if (selectedIds.length === 1) {
      const id = selectedIds[0];
      if (id === '__unassigned__') return 'Unassigned';
      if (id === '__assigned_to_me__') return 'Assigned to Me';
      const person = assignees.find((a) => a.id === id);
      return person ? person.name : '1 Assignee';
    }
    return `Assignees (${selectedIds.length})`;
  }, [selectedIds, assignees]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            selectedIds.length > 0 &&
              'border-brand-purple/40 bg-brand-50/50 text-brand-700 font-medium',
          )}
        >
          <Users className="h-3.5 w-3.5 text-ink-muted" />
          <span className="max-w-[140px] truncate">{triggerLabel}</span>
          <ChevronDown className="h-3 w-3 text-ink-disabled" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2.5">
        <div className="flex items-center justify-between pb-2 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">
            Filter Assignee(s)
          </span>
          {selectedIds.length > 0 ? (
            <button
              type="button"
              onClick={() => onSetIds([])}
              className="text-xs text-brand-600 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>

        {/* Quick select presets */}
        <div className="mb-2 flex flex-wrap gap-1.5 border-b border-line/60 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onSetIds([])}
            className={cn(
              'h-7 px-2 text-[11px]',
              selectedIds.length === 0 ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-muted',
            )}
          >
            All Team
          </Button>

          {currentUserId ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onToggle('__assigned_to_me__')}
              className={cn(
                'h-7 px-2 text-[11px]',
                selectedIds.includes('__assigned_to_me__')
                  ? 'bg-brand-50 font-semibold text-brand-700'
                  : 'text-ink-muted',
              )}
            >
              Assigned to Me
            </Button>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onToggle('__unassigned__')}
            className={cn(
              'h-7 px-2 text-[11px]',
              selectedIds.includes('__unassigned__')
                ? 'bg-brand-50 font-semibold text-brand-700'
                : 'text-ink-muted',
            )}
          >
            Unassigned
          </Button>
        </div>

        {/* Member search */}
        <div className="relative mb-2">
          <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-disabled" />
          <Input
            type="search"
            placeholder="Search members…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 pl-7 pr-2 text-xs"
          />
        </div>

        {/* Member list with checkboxes */}
        <div className="max-h-56 space-y-0.5 overflow-y-auto">
          {filteredAssignees.length === 0 ? (
            <p className="py-3 text-center text-xs text-ink-muted">
              No matching members
            </p>
          ) : (
            filteredAssignees.map((a) => {
              const checked = selectedIds.includes(a.id);
              return (
                <label
                  key={a.id}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs transition-colors hover:bg-bg-subtle',
                    checked && 'bg-brand-50/50',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => onToggle(a.id)}
                  />
                  <UserAvatar size="xs" name={a.name} image={a.image} />
                  <div className="min-w-0 flex-1 truncate">
                    <div className="truncate font-medium text-ink">{a.name}</div>
                    <div className="truncate text-[10px] text-ink-muted">
                      {a.email}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Priority Dropdown Component
// -------------------------------------------------------------
function PriorityDropdown({
  selected,
  onToggle,
  onClear,
}: {
  selected: TaskPriority[];
  onToggle: (p: TaskPriority) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-9 gap-1.5 text-xs',
            selected.length > 0 && 'border-brand-purple/40 bg-brand-50/50 text-brand-700 font-medium',
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 text-ink-muted" />
          <span>Priority{selected.length > 0 ? ` (${selected.length})` : ''}</span>
          <ChevronDown className="h-3 w-3 text-ink-disabled" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="flex items-center justify-between pb-1.5 text-[11px]">
          <span className="font-semibold uppercase tracking-wider text-ink-muted">
            Filter Priority
          </span>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={onClear}
              className="text-ink-muted hover:underline"
            >
              Reset
            </button>
          ) : null}
        </div>
        <div className="space-y-1 pt-1">
          {PRIORITY_OPTIONS.map((p) => {
            const active = selected.includes(p);
            return (
              <label
                key={p}
                className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs hover:bg-bg-subtle"
              >
                <Checkbox
                  checked={active}
                  onCheckedChange={() => onToggle(p)}
                />
                <span className="flex-1 text-ink">{priorityLabel(p)}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// -------------------------------------------------------------
// Filter Chip Component
// -------------------------------------------------------------
function FilterChip({
  label,
  onRemove,
  highlight = false,
  variant = 'default',
}: {
  label: string;
  onRemove?: () => void;
  highlight?: boolean;
  variant?: 'default' | 'subtle';
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
        variant === 'default'
          ? highlight
            ? 'border border-state-error/30 bg-state-error/10 text-state-error'
            : 'border border-brand-purple/20 bg-brand-50 text-brand-700'
          : 'border border-line bg-bg-subtle text-ink-muted',
      )}
    >
      <span>{label}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 hover:bg-black/10 focus-visible:outline-none"
          aria-label={`Remove ${label}`}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </span>
  );
}

function formatDueLabel(preset: DueDatePreset): string {
  switch (preset) {
    case 'overdue':
      return 'Overdue';
    case 'today':
      return 'Today';
    case 'tomorrow':
      return 'Tomorrow';
    case 'this_week':
      return 'This Week';
    case 'next_14_days':
      return 'Next 14 Days';
    case 'no_date':
      return 'No Due Date';
    default:
      return 'All Dates';
  }
}
