'use client';

import { ListTodo } from 'lucide-react';

import { WidgetEmpty, WidgetShell } from '@/components/dashboard/widget-shell';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useTodos, useUpdateTodo } from '@/hooks/use-todos';

export function MyTodosWidget() {
  const { data, isLoading, isError, refetch } = useTodos({
    done: false,
    dueDate: 'today_and_no_date',
    limit: 5,
  });
  const update = useUpdateTodo();
  const items = data?.items ?? [];

  return (
    <WidgetShell
      id="widget-my-todos"
      title="My Todos"
      icon={ListTodo}
      linkHref="/todo"
    >
      {isLoading ? (
        <div className="flex justify-center">
          <Loader size="sm" label="Loading" />
        </div>
      ) : isError ? (
        <QueryError compact onRetry={() => void refetch()} />
      ) : items.length === 0 ? (
        <WidgetEmpty icon={ListTodo} message="No todos for today. Nice." />
      ) : (
        <ul className="space-y-1" role="list">
          {items.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-bg-subtle transition-colors"
            >
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) =>
                  update.mutate({ id: t.id, input: { done: e.target.checked } })
                }
                aria-label={t.done ? 'Mark not done' : 'Mark done'}
                className="h-3.5 w-3.5 accent-brand-purple"
              />
              <span className="min-w-0 flex-1 truncate text-ink">{t.title}</span>
              {t.dueDate ? (
                <span className="shrink-0 text-[11px] text-ink-muted">
                  {t.dueDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
