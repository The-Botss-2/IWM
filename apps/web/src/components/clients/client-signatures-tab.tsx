'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ClientSignatureItem } from '@botss/shared-types';

import { SignatureRequestRow } from '@/components/signatures/signature-status-card';
import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { useClientSignatures } from '@/hooks/use-client-signatures';
import { useSignatureViewer } from '@/hooks/use-signatures';
import { absoluteTime, relativeTime } from '@/lib/time';

/** Signature requests tied to the client, newest first. */
export function ClientSignaturesTab({ clientId }: { clientId: string }) {
  const list = useClientSignatures(clientId);
  const viewer = useSignatureViewer();

  let body: ReactNode;
  if (!list.canRead) {
    body = (
      <p className="border-line text-ink-muted rounded-lg border bg-white p-6 text-sm">
        Your role cannot view signature requests.
      </p>
    );
  } else if (list.isLoading) {
    body = (
      <div className="space-y-2" aria-busy>
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
    );
  } else if (list.isError && list.items.length === 0) {
    body = (
      <QueryError message="Couldn't load signature requests." onRetry={() => void list.refetch()} />
    );
  } else if (list.items.length === 0) {
    body = (
      <div className="border-line rounded-lg border border-dashed bg-white p-10 text-center">
        <p className="text-ink text-sm font-medium">No signature requests yet.</p>
        <p className="text-ink-muted mt-1 text-sm">
          Use &ldquo;Request signature&rdquo; on a document in the Documents tab to send one.
        </p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2">
        {list.items.map((r) => (
          <SignatureRequestRow
            key={r.id}
            request={r}
            canManage={viewer.isWorkspaceAdmin || r.createdById === viewer.userId}
            subtitle={<RequestMeta request={r} />}
          />
        ))}
        {list.isFetchNextPageError ? (
          <QueryError
            compact
            message="Couldn't load older requests."
            onRetry={() => void list.fetchNextPage()}
          />
        ) : null}
        {list.hasNextPage ? (
          <div className="flex justify-center pt-1">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
            >
              {list.isFetchingNextPage ? 'Loading...' : 'Load older requests'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="space-y-4" aria-labelledby="client-signatures-heading">
      <div>
        <h2 id="client-signatures-heading" className="text-ink text-base font-semibold">
          Signatures
        </h2>
        <p className="text-ink-muted mt-0.5 text-sm">
          Requests for this client&apos;s documents or sent to people at this client.
        </p>
      </div>
      {body}
    </section>
  );
}

function RequestMeta({ request: r }: { request: ClientSignatureItem }) {
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {r.document ? (
        <span className="min-w-0 truncate">
          From{' '}
          <Link
            href={`/documents?doc=${encodeURIComponent(r.document.id)}`}
            className="text-brand-700 hover:underline"
          >
            {r.document.title || 'Untitled'}
          </Link>
        </span>
      ) : null}
      {r.sentAt ? (
        <Tooltip content={absoluteTime(r.sentAt)}>
          <span>Sent {relativeTime(r.sentAt)}</span>
        </Tooltip>
      ) : null}
      {r.completedAt ? (
        <Tooltip content={absoluteTime(r.completedAt)}>
          <span>Completed {relativeTime(r.completedAt)}</span>
        </Tooltip>
      ) : null}
    </span>
  );
}
