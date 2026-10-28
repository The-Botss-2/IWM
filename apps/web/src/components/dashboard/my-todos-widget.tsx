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
    <WidgetShell id="widget-my-todos" title="My Todos" icon={ListTodo} linkHref="/todo">
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
              className="hover:bg-bg-subtle flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors"
            >
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => update.mutate({ id: t.id, input: { done: e.target.checked } })}
                aria-label={t.done ? 'Mark not done' : 'Mark done'}
                className="accent-brand-purple h-3.5 w-3.5"
              />
              <span className="text-ink min-w-0 flex-1 truncate">{t.title}</span>
              {t.dueDate ? (
                <span className="text-ink-muted shrink-0 text-[11px]">
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
