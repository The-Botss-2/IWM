'use client';

import { CalendarDays, GripVertical, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { TodoPriority, TodoWithRefs } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

export const PRIORITY_TONE: Record<TodoPriority, string> = {
  NONE: 'bg-bg-subtle text-ink-muted',
  LOW: 'bg-brand-blue/15 text-brand-blue',
  MEDIUM: 'bg-brand-orange/15 text-brand-orange',
  HIGH: 'bg-state-error/15 text-state-error',
};

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  NONE: 'No priority',
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
};

export const PRIORITY_ORDER: TodoPriority[] = ['HIGH', 'MEDIUM', 'LOW', 'NONE'];

export interface TodoRowProps {
  todo: TodoWithRefs;
  onToggle: (done: boolean) => void;
  onRename: (title: string) => void;
  onPriority: (priority: TodoPriority) => void;
  onDelete: () => void;
  onShare: () => void;
  /** dnd-kit drag handle props from `useSortable`. Omit for static lists. */
  dragHandleProps?: Record<string, unknown>;
  /**
   * Suppress workspace / project chips. The project page already lives
   * inside the project's context so showing them on every row is noise.
   */
  hideContextBadges?: boolean;
}

/**
 * Shared todo row. The same component renders inside `/todo` (org-wide
 * view) and inside the project detail page's Todos tab. Context badges
 * (workspace name, project chip) can be suppressed via
 * `hideContextBadges` for surfaces where the context is implicit.
 */
export function TodoRow({
  todo,
  onToggle,
  onRename,
  onPriority,
  onDelete,
  onShare,
  dragHandleProps,
  hideContextBadges,
}: TodoRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(todo.title);

  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === todo.title) {
      setDraft(todo.title);
      return;
    }
    onRename(next);
  }

  return (
    <div className="group flex items-center gap-2 rounded-md border border-line bg-bg-surface px-2 py-2 shadow-sm hover:border-line-strong">
      {dragHandleProps ? (
        <button
          type="button"
          aria-label="Drag to reorder"
          className="cursor-grab text-line-strong hover:text-ink-muted"
          {...dragHandleProps}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <input
        id={`todo-${todo.id}-done`}
        type="checkbox"
        checked={todo.done}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={todo.done ? 'Mark not done' : 'Mark done'}
        className="h-4 w-4 cursor-pointer accent-emerald-600"
      />
      <div className="min-w-0 flex-1">
        {editing ? (
          <Input
            id={`todo-${todo.id}-title`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(todo.title);
                setEditing(false);
              }
            }}
            autoFocus
            className="h-7"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              'block w-full truncate text-left text-sm transition-all',
              todo.done ? 'text-ink-disabled line-through' : 'text-ink',
            )}
          >
            {todo.title}
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
          {todo.dueDate ? (
            <span
              className="inline-flex items-center gap-1"
              title={absoluteTime(todo.dueDate)}
            >
              <CalendarDays className="h-3 w-3" aria-hidden />
              {relativeTime(todo.dueDate)}
            </span>
          ) : null}
          {!hideContextBadges && todo.workspace ? (
            <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
              {todo.workspace.name}
            </span>
          ) : null}
          {!hideContextBadges && todo.project ? (
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: todo.project.color
                  ? `${todo.project.color}22`
                  : '#e2e8f0',
                color: todo.project.color ?? '#475569',
              }}
            >
              {todo.project.name}
            </span>
          ) : null}
          {todo.creator && todo.assignee && todo.creator.id !== todo.assignee.id ? (
            <span className="inline-flex items-center gap-1 rounded bg-brand-orange/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-orange">
              Assigned by {todo.creator.name?.split(' ')[0] ?? todo.creator.email}
            </span>
          ) : null}
          {hideContextBadges &&
          todo.assignee &&
          todo.creator &&
          todo.creator.id !== todo.assignee.id ? (
            <span className="inline-flex items-center gap-1 rounded bg-bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-ink">
              For {todo.assignee.name?.split(' ')[0] ?? todo.assignee.email}
            </span>
          ) : null}
        </div>
      </div>
      <select
        id={`todo-${todo.id}-priority`}
        value={todo.priority}
        onChange={(e) => onPriority(e.target.value as TodoPriority)}
        aria-label="Priority"
        className={cn(
          'h-6 rounded-full border-0 px-2 text-[11px] font-medium',
          PRIORITY_TONE[todo.priority],
        )}
      >
        {PRIORITY_ORDER.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABEL[p]}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Share to chat"
        onClick={onShare}
        className="h-7 w-7 text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:text-brand-teal"
      >
        <Send className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Delete todo"
        onClick={onDelete}
        className="h-7 w-7 text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:text-state-error"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
