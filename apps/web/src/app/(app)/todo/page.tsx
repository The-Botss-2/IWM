'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type {
  CreateTodoInput,
  TodoDueFilter,
  TodoPriority,
  TodoWithRefs,
} from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { ShareToChatDialog } from '@/components/chat/share-to-chat-dialog';
import { TodoRow } from '@/components/todos/todo-row';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  useCreateTodo,
  useDeleteTodo,
  useTodos,
  useTodoComposerTargets,
  useUpdateTodo,
} from '@/hooks/use-todos';
import { useWorkspaces } from '@/hooks/use-workspace';
import { cn } from '@/lib/utils';

type Tab = 'today' | 'upcoming' | 'all';

function dueFilterForTab(tab: Tab): TodoDueFilter | undefined {
  if (tab === 'today') return 'today_and_no_date';
  if (tab === 'upcoming') return 'upcoming';
  return undefined;
}

export default function TodoPage() {
  const [tab, setTab] = useState<Tab>('today');
  const [newTitle, setNewTitle] = useState('');
  const [completedOpen, setCompletedOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const dueFilter = dueFilterForTab(tab);
  // Org-aggregate by default - show todos the user created OR was
  // assigned in any workspace they belong to.
  const openQuery = useTodos({
    done: false,
    dueDate: dueFilter,
    aggregate: 'org',
  });
  const doneQuery = useTodos({ done: true, limit: 100, aggregate: 'org' });
  const create = useCreateTodo();
  const update = useUpdateTodo();
  const remove = useDeleteTodo();

  const openItems = useMemo(
    () => [...(openQuery.data?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [openQuery.data],
  );
  const doneItems = useMemo(
    () =>
      [...(doneQuery.data?.items ?? [])].sort(
        (a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0),
      ),
    [doneQuery.data],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(e: DragEndEvent): void {
    if (!e.over) return;
    const oldIndex = openItems.findIndex((t) => t.id === e.active.id);
    const newIndex = openItems.findIndex((t) => t.id === e.over!.id);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const reordered = arrayMove(openItems, oldIndex, newIndex);
    reordered.forEach((item, idx) => {
      if (item.sortOrder !== idx) {
        update.mutate({ id: item.id, input: { sortOrder: idx } });
      }
    });
  }

  return (
    <div className="mx-auto h-[var(--app-content-h,calc(100vh-4rem))] w-full max-w-3xl overflow-y-auto px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-ink text-2xl font-semibold">Todos</h1>
        <p className="text-ink-muted mt-0.5 text-sm">
          Your personal task list. Press Enter to save a new item.
        </p>
      </header>

      <div className="border-line bg-bg-surface mb-4 inline-flex rounded-md border p-0.5 text-sm">
        {(['today', 'upcoming', 'all'] as const).map((t) => (
          <button
            key={t}
            id={`todo-tab-${t}`}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={cn(
              'rounded px-3 py-1.5 capitalize transition-colors',
              tab === t ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:text-ink',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <TodoComposer
        defaultValue={newTitle}
        onValueChange={setNewTitle}
        pending={create.isPending}
        onSubmit={(payload) => {
          create.mutate(payload, {
            onSuccess: () => setNewTitle(''),
          });
        }}
      />

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={openItems.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {openQuery.isLoading ? (
            <EmptyHint>
              <Loader size="sm" label="Loading" />
            </EmptyHint>
          ) : openQuery.isError && !openQuery.data ? (
            <QueryError
              message="Couldn't load your to-dos."
              onRetry={() => void openQuery.refetch()}
            />
          ) : openItems.length === 0 ? (
            <EmptyHint>Nothing here. Take a breath.</EmptyHint>
          ) : (
            <ul className="space-y-1.5" role="list">
              {openItems.map((t) => (
                <SortableTodoRow
                  key={t.id}
                  todo={t}
                  onToggle={(done) => update.mutate({ id: t.id, input: { done } })}
                  onRename={(title) => update.mutate({ id: t.id, input: { title } })}
                  onPriority={(priority) => update.mutate({ id: t.id, input: { priority } })}
                  onDelete={() => remove.mutate(t.id)}
                  onShare={() => setShareTarget({ id: t.id, title: t.title })}
                />
              ))}
            </ul>
          )}
        </SortableContext>
      </DndContext>

      {doneItems.length > 0 ? (
        <section className="mt-8">
          <button
            type="button"
            id="todo-completed-toggle"
            onClick={() => setCompletedOpen((v) => !v)}
            aria-expanded={completedOpen}
            className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide"
          >
            {completedOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Completed ({doneItems.length})
          </button>
          {completedOpen ? (
            <ul className="mt-2 space-y-1.5" role="list">
              {doneItems.map((t) => (
                <TodoRow
                  key={t.id}
                  todo={t}
                  onToggle={(done) => update.mutate({ id: t.id, input: { done } })}
                  onRename={(title) => update.mutate({ id: t.id, input: { title } })}
                  onPriority={(priority) => update.mutate({ id: t.id, input: { priority } })}
                  onDelete={() => remove.mutate(t.id)}
                  onShare={() => setShareTarget({ id: t.id, title: t.title })}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {shareTarget ? (
        <ShareToChatDialog
          open={shareTarget !== null}
          onOpenChange={(next) => {
            if (!next) setShareTarget(null);
          }}
          itemType="todo"
          itemId={shareTarget.id}
          itemLabel={shareTarget.title}
        />
      ) : null}
    </div>
  );
}

/**
 * Inline todo creator. Title is always visible (press Enter to create
 * a quick personal todo). The disclosure expands a small form for
 * picking a target workspace, project, and assignee - used when a
 * boss wants to drop a todo into someone else's inbox or into a
 * specific project list.
 */
function TodoComposer({
  defaultValue,
  onValueChange,
  onSubmit,
  pending,
}: {
  defaultValue: string;
  onValueChange: (next: string) => void;
  onSubmit: (input: CreateTodoInput) => void;
  pending: boolean;
}) {
  const session = useSessionContext();
  const currentUserId = session.data?.user?.id ?? '';
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');
  const [assigneeId, setAssigneeId] = useState<string>('');

  const workspaces = useWorkspaces();
  const { projectsForWorkspace, members } = useTodoComposerTargets(workspaceId);

  function submit(): void {
    const title = defaultValue.trim();
    if (!title) return;
    onSubmit({
      title,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(assigneeId && assigneeId !== currentUserId ? { assigneeId } : {}),
    });
    setProjectId('');
    setAssigneeId('');
    setOpen(false);
  }

  return (
    <div className="border-line bg-bg-surface mb-3 rounded-md border p-2 shadow-sm">
      <div className="flex items-center gap-2">
        <Plus className="text-ink-disabled ml-1 h-4 w-4" aria-hidden />
        <Input
          id="todo-new-title"
          aria-label="New todo"
          value={defaultValue}
          onChange={(e) => onValueChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a todo, then press Enter"
          className="border-0 shadow-none focus-visible:ring-0"
        />
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'Hide options' : 'Show options'}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            open ? 'bg-brand-50 text-brand-700' : 'text-ink-muted hover:bg-bg-subtle',
          )}
        >
          {open ? 'Hide' : 'Options'}
        </button>
      </div>
      {open ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={(e) => {
              setWorkspaceId(e.target.value);
              setProjectId('');
              setAssigneeId('');
            }}
            className="border-line bg-bg-surface h-9 rounded-md border px-2 text-sm"
          >
            <option value="">Current workspace</option>
            {(workspaces.data?.items ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Project"
            value={projectId}
            disabled={!workspaceId}
            onChange={(e) => setProjectId(e.target.value)}
            className="border-line bg-bg-surface h-9 rounded-md border px-2 text-sm disabled:opacity-50"
          >
            <option value="">No project</option>
            {projectsForWorkspace.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Assignee"
            value={assigneeId}
            disabled={!workspaceId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="border-line bg-bg-surface h-9 rounded-md border px-2 text-sm disabled:opacity-50"
          >
            <option value="">Me (default)</option>
            {(members.data ?? [])
              .filter((m) => m.user.id !== currentUserId)
              .map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  Assign to {m.user.name || m.user.email}
                </option>
              ))}
          </select>
          <div className="flex justify-end sm:col-span-3">
            <Button size="sm" onClick={submit} disabled={pending || !defaultValue.trim()}>
              {pending ? 'Adding…' : 'Add todo'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SortableTodoRow(props: {
  todo: TodoWithRefs;
  onToggle: (done: boolean) => void;
  onRename: (title: string) => void;
  onPriority: (priority: TodoPriority) => void;
  onDelete: () => void;
  onShare: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.todo.id,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li ref={setNodeRef} style={style}>
      <TodoRow {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </li>
  );
}

function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="border-line text-ink-muted rounded-md border border-dashed p-8 text-center text-sm">
      {children}
    </div>
  );
}
