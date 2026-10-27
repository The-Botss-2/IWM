'use client';

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
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
import { CheckCircle2, Lock, Pencil, Play, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SPRINT_DATES_MESSAGE,
  type SprintWithStats,
  type TaskWithPeople,
} from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { PriorityBadge } from '@/components/tasks/task-badges';
import {
  useAddSprintTask,
  useCompleteSprint,
  useCreateSprint,
  useMoveSprintTask,
  useRemoveSprintTask,
  useReorderSprintTask,
  useSprints,
  sprintChanges,
  type SprintForm,
  useStartSprint,
  useUpdateSprint,
} from '@/hooks/use-sprints';
import { useTasks } from '@/hooks/use-tasks';
import { abilityRow, useAbility } from '@/lib/ability';
import { toast, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

const BACKLOG_DROP_ID = '__backlog__';

export default function BacklogView({ projectId }: { projectId: string }) {
  const sprints = useSprints(projectId);
  const tasks = useTasks({ projectId, pageSize: 200 });
  const createSprint = useCreateSprint(projectId);
  const startSprint = useStartSprint(projectId);
  const completeSprint = useCompleteSprint(projectId);
  const addTask = useAddSprintTask(projectId);
  const removeTask = useRemoveSprintTask(projectId);
  const moveTask = useMoveSprintTask(projectId);
  const reorderTask = useReorderSprintTask(projectId);
  const updateSprint = useUpdateSprint(projectId);
  // Sprint edits are `update Project` on the API. UX hint only.
  const canEditSprints = useAbility().can('update', abilityRow('Project', { id: projectId }));

  const [newOpen, setNewOpen] = useState(false);
  const [editingSprint, setEditingSprint] = useState<SprintWithStats | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // Resolve task records by id from the loaded tasks cache.
  const taskById = useMemo(() => {
    const map = new Map<string, TaskWithPeople>();
    for (const t of tasks.data?.items ?? []) map.set(t.id, t);
    return map;
  }, [tasks.data]);

  // Backlog = tasks with BACKLOG status that are NOT already in a sprint.
  const sprintMembership = useMemo(() => {
    const set = new Set<string>();
    for (const s of sprints.data ?? []) {
      for (const tid of s.taskIds) set.add(tid);
    }
    return set;
  }, [sprints.data]);

  const backlogTaskIds = useMemo(
    () =>
      (tasks.data?.items ?? [])
        .filter(
          (t) =>
            t.status === 'BACKLOG' && t.deletedAt === null && !sprintMembership.has(t.id),
        )
        .sort((a, b) => a.position - b.position)
        .map((t) => t.id),
    [tasks.data, sprintMembership],
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Find which container (backlog or a sprint id) a given task currently sits in.
  const containerOfTask = useCallback(
    (taskId: string): string | null => {
      for (const s of sprints.data ?? []) {
        if (s.taskIds.includes(taskId)) return s.id;
      }
      if (backlogTaskIds.includes(taskId)) return BACKLOG_DROP_ID;
      return null;
    },
    [sprints.data, backlogTaskIds],
  );

  const containerForOverId = useCallback(
    (overId: string): { container: string; position: number } | null => {
      // Dropping on a container itself (empty space).
      if (overId === BACKLOG_DROP_ID) {
        return { container: BACKLOG_DROP_ID, position: backlogTaskIds.length };
      }
      const onSprint = (sprints.data ?? []).find((s) => s.id === overId);
      if (onSprint) {
        return { container: onSprint.id, position: onSprint.taskIds.length };
      }
      // Dropping on a task - figure out which container it lives in.
      const fromSprint = (sprints.data ?? []).find((s) => s.taskIds.includes(overId));
      if (fromSprint) {
        const idx = fromSprint.taskIds.indexOf(overId);
        return { container: fromSprint.id, position: idx };
      }
      if (backlogTaskIds.includes(overId)) {
        return { container: BACKLOG_DROP_ID, position: backlogTaskIds.indexOf(overId) };
      }
      return null;
    },
    [sprints.data, backlogTaskIds],
  );

  const onDragStart = (e: DragStartEvent) => {
    setDraggingId(String(e.active.id));
  };

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setDraggingId(null);
      if (!e.over) return;
      const activeId = String(e.active.id);
      const overId = String(e.over.id);
      if (activeId === overId) return;

      const from = containerOfTask(activeId);
      const target = containerForOverId(overId);
      if (!from || !target) return;
      if (from === target.container && from === BACKLOG_DROP_ID) {
        // Reordering within backlog updates Task.position. Without a server
        // endpoint for it yet, we rely on PATCH /tasks/:id/reorder using the
        // BACKLOG status.
        // No-op for now - backlog reorder isn't visually meaningful with the
        // current Task.position sort (status='BACKLOG' rows are co-ordered
        // with the kanban Backlog column).
        return;
      }

      // Block drops into completed sprints.
      const targetSprint = (sprints.data ?? []).find((s) => s.id === target.container);
      if (targetSprint && targetSprint.status === 'COMPLETED') {
        toastErrorMessage('Sprint is completed. Tasks cannot be added or moved here.');
        return;
      }

      if (from === BACKLOG_DROP_ID && target.container !== BACKLOG_DROP_ID) {
        addTask.mutate({ sprintId: target.container, taskId: activeId });
        return;
      }
      if (from !== BACKLOG_DROP_ID && target.container === BACKLOG_DROP_ID) {
        removeTask.mutate({ sprintId: from, taskId: activeId });
        return;
      }
      if (from !== BACKLOG_DROP_ID && target.container !== BACKLOG_DROP_ID) {
        if (from === target.container) {
          reorderTask.mutate({
            sprintId: from,
            input: { taskId: activeId, position: target.position },
          });
          return;
        }
        moveTask.mutate({
          taskId: activeId,
          fromSprintId: from,
          toSprintId: target.container,
          position: target.position,
        });
      }
    },
    [containerOfTask, containerForOverId, sprints.data, addTask, removeTask, reorderTask, moveTask],
  );

  const draggedTask = draggingId ? taskById.get(draggingId) ?? null : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        {tasks.isError && !tasks.data ? (
          <QueryError message="Couldn't load backlog tasks." onRetry={() => void tasks.refetch()} />
        ) : (
          <BacklogPane
            ids={backlogTaskIds}
            taskById={taskById}
            loading={tasks.isLoading}
          />
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-ink">Sprints</h3>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" /> New sprint
            </Button>
          </div>

          {sprints.isLoading ? (
            <Skeleton className="h-32" />
          ) : sprints.isError && !sprints.data ? (
            <QueryError message="Couldn't load sprints." onRetry={() => void sprints.refetch()} />
          ) : sprints.data && sprints.data.length > 0 ? (
            sprints.data.map((s) => (
              <SprintCard
                key={s.id}
                sprint={s}
                taskById={taskById}
                onStart={() => startSprint.mutate(s.id)}
                onComplete={() => completeSprint.mutate(s.id)}
                {...(canEditSprints ? { onEdit: () => setEditingSprint(s) } : {})}
              />
            ))
          ) : (
            <div className="rounded-md border border-dashed border-line p-6 text-center text-sm text-ink-muted">
              No sprints yet.
            </div>
          )}
        </section>

        <SprintDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          onSubmit={async (input) => {
            try {
              await createSprint.mutateAsync({
                name: input.name,
                ...(input.goal ? { goal: input.goal } : {}),
                startDate: input.startDate,
                endDate: input.endDate,
              });
              toast.success(`Sprint "${input.name}" created.`);
              setNewOpen(false);
            } catch {
              /* hook surfaces toast */
            }
          }}
          pending={createSprint.isPending}
        />
        <SprintDialog
          open={!!editingSprint}
          onOpenChange={(o) => !o && setEditingSprint(null)}
          existing={editingSprint}
          onSubmit={async (input) => {
            if (!editingSprint) return;
            const changes = sprintChanges(editingSprint, input);
            try {
              if (Object.keys(changes).length > 0) {
                await updateSprint.mutateAsync({ id: editingSprint.id, input: changes });
              }
              setEditingSprint(null);
            } catch {
              /* hook surfaces toast */
            }
          }}
          pending={updateSprint.isPending}
        />
      </div>

      <DragOverlay>
        {draggedTask ? (
          <div className="rounded-md border border-line-strong bg-white px-3 py-2 text-sm shadow-lg">
            {draggedTask.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function BacklogPane({
  ids,
  taskById,
  loading,
}: {
  ids: string[];
  taskById: Map<string, TaskWithPeople>;
  loading: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: BACKLOG_DROP_ID });
  return (
    <section
      ref={setNodeRef}
      className={cn(
        'rounded-lg border border-line bg-white p-4 transition-colors',
        isOver && 'border-brand-400 bg-brand-50/40',
      )}
    >
      <h3 className="text-sm font-semibold text-ink">Backlog</h3>
      {loading ? (
        <Skeleton className="mt-3 h-32" />
      ) : ids.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">No backlog tasks.</p>
      ) : (
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="mt-3 space-y-1.5">
            {ids.map((id) => {
              const t = taskById.get(id);
              if (!t) return null;
              return <TaskRow key={id} task={t} />;
            })}
          </ul>
        </SortableContext>
      )}
    </section>
  );
}

function SprintCard({
  sprint,
  taskById,
  onStart,
  onComplete,
  onEdit,
}: {
  sprint: SprintWithStats;
  taskById: Map<string, TaskWithPeople>;
  onStart: () => void;
  onComplete: () => void;
  /** Absent when the viewer cannot edit sprints. */
  onEdit?: () => void;
}) {
  const tone =
    sprint.status === 'ACTIVE' ? 'brand' : sprint.status === 'COMPLETED' ? 'neutral' : 'info';
  const isCompleted = sprint.status === 'COMPLETED';
  const { setNodeRef, isOver } = useDroppable({ id: sprint.id, disabled: isCompleted });
  return (
    <article
      ref={setNodeRef}
      className={cn(
        'rounded-lg border bg-white p-4 transition-colors',
        isCompleted ? 'border-line opacity-90' : 'border-line',
        isOver && !isCompleted && 'border-brand-400 bg-brand-50/40',
        isOver && isCompleted && 'cursor-not-allowed',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-ink">{sprint.name}</h4>
            <Badge tone={tone}>{sprint.status}</Badge>
            {isCompleted ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] text-ink-muted"
                aria-label="Locked"
              >
                <Lock className="h-3 w-3" />
                Locked
              </span>
            ) : null}
          </div>
          {sprint.goal ? <p className="mt-0.5 text-xs text-ink-muted">{sprint.goal}</p> : null}
          <p className="mt-1 text-xs text-ink-muted">
            {sprint.taskCount} tasks · {sprint.totalEstimateHours.toFixed(1)}h
          </p>
        </div>
        <div className="flex gap-2">
          {onEdit && !isCompleted ? (
            <Button size="sm" variant="ghost" aria-label={`Edit ${sprint.name}`} onClick={onEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
          ) : null}
          {sprint.status === 'PLANNED' ? (
            <Button size="sm" variant="secondary" onClick={onStart}>
              <Play className="h-3 w-3" /> Start
            </Button>
          ) : null}
          {sprint.status === 'ACTIVE' ? (
            <Button size="sm" variant="secondary" onClick={onComplete}>
              <CheckCircle2 className="h-3 w-3" /> Complete
            </Button>
          ) : null}
        </div>
      </div>

      <SortableContext items={sprint.taskIds} strategy={verticalListSortingStrategy}>
        <ul className="mt-3 min-h-[60px] space-y-1.5">
          {sprint.taskIds.length === 0 ? (
            <li className="rounded-md border border-dashed border-line px-3 py-3 text-center text-xs text-ink-disabled">
              Drop tasks here
            </li>
          ) : (
            sprint.taskIds.map((id) => {
              const t = taskById.get(id);
              if (!t) return null;
              return <TaskRow key={id} task={t} disabled={isCompleted} />;
            })
          )}
        </ul>
      </SortableContext>
    </article>
  );
}

function TaskRow({ task, disabled }: { task: TaskWithPeople; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <li className="list-none">
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        className={cn(
          'flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm bg-white',
          disabled ? 'cursor-not-allowed' : 'cursor-grab active:cursor-grabbing',
        )}
      >
        <span className="truncate">{task.title}</span>
        <PriorityBadge priority={task.priority} />
      </div>
    </li>
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** New sprint, or edit `existing` (name, goal and dates). */
function SprintDialog({
  open,
  onOpenChange,
  existing = null,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  existing?: SprintWithStats | null;
  onSubmit: (input: SprintForm) => void;
  pending: boolean;
}) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [startDate, setStartDate] = useState(() => isoDay(new Date()));
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return isoDay(d);
  });

  useEffect(() => {
    if (!open || !existing) return;
    setName(existing.name);
    setGoal(existing.goal ?? '');
    setStartDate(isoDay(new Date(existing.startDate)));
    setEndDate(isoDay(new Date(existing.endDate)));
  }, [open, existing]);

  // Same rule as the API: a sprint may be one day, never end before it starts.
  const datesInvalid = Boolean(startDate && endDate && endDate < startDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit sprint' : 'New sprint'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="sprint-name">Name</Label>
            <Input id="sprint-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sprint-goal">Goal (optional)</Label>
            <Input id="sprint-goal" value={goal} onChange={(e) => setGoal(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="sprint-start">Start</Label>
              <Input
                id="sprint-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sprint-end">End</Label>
              <Input
                id="sprint-end"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-invalid={datesInvalid || undefined}
                aria-describedby={datesInvalid ? 'sprint-dates-error' : undefined}
              />
            </div>
          </div>
          {datesInvalid ? (
            <p id="sprint-dates-error" className="text-xs text-state-error">
              {SPRINT_DATES_MESSAGE}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !name.trim() || !startDate || !endDate || datesInvalid}
            onClick={() =>
              onSubmit({
                name: name.trim(),
                goal: goal.trim(),
                startDate: new Date(startDate),
                endDate: new Date(endDate),
              })
            }
          >
            {pending ? 'Saving…' : existing ? 'Save sprint' : 'Create sprint'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
