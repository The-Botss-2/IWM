'use client';

import Link from 'next/link';
import type { TaskWithPeople } from '@botss/shared-types';

import { CustomFieldControl } from '@/components/custom-fields/custom-field-control';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useTaskCustomFields } from '@/hooks/use-custom-fields';
import { Can } from '@/lib/ability';

/**
 * The task's project fields in the task panel. Each change is one request
 * and patches the cache optimistically; nothing refetches while editing.
 * Hidden when the project has no task fields, unless the viewer can add some.
 */
export function TaskCustomFields({ task }: { task: TaskWithPeople }) {
  const cf = useTaskCustomFields(task);

  if (cf.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (cf.isError) {
    return <QueryError message="Couldn't load custom fields." onRetry={cf.refetch} />;
  }
  if (cf.fields.length === 0) {
    return (
      <Can I="manage" a="Workspace">
        <p className="text-ink-muted text-xs">
          No custom fields on this project.{' '}
          <Link href="/settings/workspace/custom-fields" className="underline">
            Add fields in Settings
          </Link>
        </p>
      </Can>
    );
  }

  return (
    <section aria-labelledby="task-custom-fields-heading" className="space-y-3">
      <div>
        <h3 id="task-custom-fields-heading" className="text-ink text-sm font-medium">
          Custom fields
        </h3>
        {cf.readOnly ? (
          <p className="text-ink-muted text-xs">You can view these fields but not change them.</p>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {cf.fields.map((f) => (
          <CustomFieldControl
            key={f.definition.id}
            idPrefix={`task-cf-${task.id}`}
            field={f}
            readOnly={cf.readOnly}
            onSave={(value) => cf.save(f.definition.id, value)}
          />
        ))}
      </div>
    </section>
  );
}
