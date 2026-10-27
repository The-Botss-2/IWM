'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CreateTodoInput } from '@botss/shared-types';

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
  useUpdateTodo,
} from '@/hooks/use-todos';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  projectId: string;
  workspaceId: string;
}

/**
 * Project-scoped todo list. Same `TodoRow` + same backing API as the
 * standalone `/todo` page, but filtered to one project and with the
 * workspace + project pickers stripped out of the composer (both are
 * implicit). Assignee picker lists the project's members.
 */
export function ProjectTodosView({ projectId, workspaceId }: Props) {
  const session = useSessionContext();
  const currentUserId = session.data?.user?.id ?? '';

  const todosQuery = useTodos({ projectId });
  const create = useCreateTodo();
  const update = useUpdateTodo();
  const remove = useDeleteTodo();

  const members = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => getApi().projectMembers.list(projectId),
    staleTime: 60_000,
  });

  const [title, setTitle] = useState('');
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [shareTarget, setShareTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);

  // Open todos rendered above completed. Within each bucket, sortOrder
  // preserves the user-defined order from the org-wide todo page.
  const items = useMemo(() => {
    const all = todosQuery.data?.items ?? [];
    const open = all
      .filter((t) => !t.done)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const done = all
      .filter((t) => t.done)
      .sort(
        (a, b) => (b.doneAt?.getTime() ?? 0) - (a.doneAt?.getTime() ?? 0),
      );
    return { open, done };
  }, [todosQuery.data]);

  function submit(): void {
    const trimmed = title.trim();
    if (!trimmed) return;
    const payload: CreateTodoInput = {
      title: trimmed,
      workspaceId,
      projectId,
      ...(assigneeId && assigneeId !== currentUserId ? { assigneeId } : {}),
    };
    create.mutate(payload, {
      onSuccess: () => {
        setTitle('');
        setAssigneeId('');
      },
    });
  }

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-line bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Plus className="ml-1 h-4 w-4 text-ink-disabled" aria-hidden />
          <Input
            id="project-todo-new-title"
            aria-label="New todo for this project"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add a todo to this project, then press Enter"
            className="min-w-0 flex-1 border-0 shadow-none focus-visible:ring-0"
          />
          <select
            aria-label="Assignee"
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="h-9 rounded-md border border-line bg-white px-2 text-sm"
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
          <Button
            size="sm"
            onClick={submit}
            disabled={create.isPending || !title.trim()}
          >
            {create.isPending ? 'Adding…' : 'Add'}
          </Button>
        </div>
      </section>

      <section className="space-y-1.5">
        {todosQuery.isLoading ? (
          <Empty>
            <Loader label="Loading" />
          </Empty>
        ) : todosQuery.isError && !todosQuery.data ? (
          <QueryError
            message="Couldn't load todos."
            onRetry={() => void todosQuery.refetch()}
          />
        ) : items.open.length === 0 ? (
          <Empty>No open todos for this project yet.</Empty>
        ) : (
          <ul className="space-y-1.5" role="list">
            {items.open.map((t) => (
              <li key={t.id}>
                <TodoRow
                  todo={t}
                  hideContextBadges
                  onToggle={(done) =>
                    update.mutate({ id: t.id, input: { done } })
                  }
                  onRename={(next) =>
                    update.mutate({ id: t.id, input: { title: next } })
                  }
                  onPriority={(priority) =>
                    update.mutate({ id: t.id, input: { priority } })
                  }
                  onDelete={() => remove.mutate(t.id)}
                  onShare={() =>
                    setShareTarget({ id: t.id, title: t.title })
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {items.done.length > 0 ? (
          <details className="mt-3 rounded-md">
            <summary
              className={cn(
                'cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-ink-muted',
                'hover:text-ink',
              )}
            >
              Completed ({items.done.length})
            </summary>
            <ul className="mt-2 space-y-1.5" role="list">
              {items.done.map((t) => (
                <li key={t.id}>
                  <TodoRow
                    todo={t}
                    hideContextBadges
                    onToggle={(done) =>
                      update.mutate({ id: t.id, input: { done } })
                    }
                    onRename={(next) =>
                      update.mutate({ id: t.id, input: { title: next } })
                    }
                    onPriority={(priority) =>
                      update.mutate({ id: t.id, input: { priority } })
                    }
                    onDelete={() => remove.mutate(t.id)}
                    onShare={() =>
                      setShareTarget({ id: t.id, title: t.title })
                    }
                  />
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-line bg-white p-8 text-center text-sm text-ink-muted">
      {children}
    </div>
  );
}
