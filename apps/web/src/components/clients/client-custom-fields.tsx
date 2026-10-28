'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { CustomFieldControl } from '@/components/custom-fields/custom-field-control';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { useClientCustomFields } from '@/hooks/use-client-custom-fields';
import { Can } from '@/lib/ability';

/**
 * The workspace's client custom fields on one client, on the Overview tab.
 * Hidden when the workspace has none, unless the viewer can add some.
 */
export function ClientCustomFields({ clientId }: { clientId: string }) {
  const cf = useClientCustomFields(clientId);

  if (cf.unavailable) return null;

  let body: ReactNode;
  if (cf.isLoading) {
    body = (
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  } else if (cf.isError) {
    body = (
      <QueryError className="mt-4" message="Couldn't load custom fields." onRetry={cf.refetch} />
    );
  } else if (cf.fields.length === 0) {
    body = (
      <p className="text-ink-muted mt-2 text-sm">
        No custom fields for clients yet.{' '}
        <Can I="update" a="Workspace">
          <Link href="/settings/workspace/custom-fields" className="underline">
            Add fields in Settings
          </Link>
        </Can>
      </p>
    );
  } else {
    body = (
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {cf.fields.map((f) => (
          <CustomFieldControl
            key={f.definition.id}
            idPrefix="client-cf"
            field={f}
            readOnly={cf.readOnly}
            onSave={(value) => cf.save(f.definition.id, value)}
          />
        ))}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="client-custom-fields-heading"
      className="border-line rounded-lg border bg-white p-5"
    >
      <h2 id="client-custom-fields-heading" className="text-ink text-base font-semibold">
        Custom fields
      </h2>
      {!cf.isLoading && cf.fields.length > 0 ? (
        <p className="text-ink-muted mt-1 text-sm">
          {cf.readOnly
            ? 'You can view these fields but not change them.'
            : 'Changes save automatically.'}
        </p>
      ) : null}
      {body}
    </section>
  );
}
