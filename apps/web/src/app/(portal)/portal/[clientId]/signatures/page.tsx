'use client';

import { ChevronRight, FileSignature } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import type { PortalSignatureItem } from '@botss/shared-types';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import {
  portalSignatureState,
  usePortalSignatures,
  type PortalSignatureState,
} from '@/hooks/use-portal-signatures';

const BADGE: Record<PortalSignatureState, { label: string; tone: NonNullable<BadgeProps['tone']> }> = {
  new: { label: 'New', tone: 'info' },
  opened: { label: 'Opened', tone: 'neutral' },
  signed: { label: 'You signed', tone: 'outline' },
  completed: { label: 'Completed', tone: 'success' },
  declined: { label: 'You declined', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'warning' },
};

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Signature requests addressed to the signed-in person at this client. */
export default function PortalSignaturesPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const list = usePortalSignatures(clientId);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Signatures</h1>
        <p className="mt-1 text-sm text-ink-muted">Documents you have been asked to sign.</p>
      </div>

      {list.data ? (
        list.data.total === 0 ? (
          <EmptyState />
        ) : (
          <>
            <Group
              id="waiting"
              title="Waiting for you"
              count={list.data.waiting.length}
              empty="Nothing is waiting for your signature."
            >
              {list.data.waiting.map((item) => (
                <Row key={item.signerId} clientId={clientId} item={item} waiting />
              ))}
            </Group>
            <Group
              id="past"
              title="Completed and past"
              count={list.data.past.length}
              empty="Signed, declined and expired requests show up here."
            >
              {list.data.past.map((item) => (
                <Row key={item.signerId} clientId={clientId} item={item} waiting={false} />
              ))}
            </Group>
          </>
        )
      ) : list.isError ? (
        <QueryError
          message="Couldn't load your signature requests."
          onRetry={() => void list.refetch()}
        />
      ) : (
        <ListSkeleton />
      )}
    </div>
  );
}

function Group({
  id,
  title,
  count,
  empty,
  children,
}: {
  id: string;
  title: string;
  count: number;
  empty: string;
  children: ReactNode;
}) {
  const headingId = `signatures-${id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold text-ink">
        {title}
        <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-xs font-medium text-ink-muted">{count}</span>
      </h2>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-5 text-sm text-ink-muted">{empty}</p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
}

function Row({
  clientId,
  item,
  waiting,
}: {
  clientId: string;
  item: PortalSignatureItem;
  waiting: boolean;
}) {
  const state = portalSignatureState(item);
  const badge = BADGE[state];
  return (
    <li>
      <Link
        href={`/portal/${clientId}/signatures/${item.signerId}`}
        className="flex items-center gap-3 rounded-lg border border-line bg-bg-surface p-4 transition-colors hover:bg-bg-subtle focus-visible:outline-none focus-visible:shadow-focus"
      >
        <FileSignature className="h-5 w-5 shrink-0 text-brand-purple" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-sm font-medium text-ink">{item.title}</span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-ink-muted">From {item.requesterName}</p>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted">
            {item.sentAt ? <DateText label="Sent" value={item.sentAt} /> : null}
            {item.signedAt ? <DateText label="Signed" value={item.signedAt} /> : null}
            {item.completedAt ? <DateText label="Completed" value={item.completedAt} /> : null}
            {waiting ? <DateText label="Sign by" value={item.expiresAt} /> : null}
            {state === 'expired' ? <DateText label="Expired" value={item.expiresAt} /> : null}
          </p>
        </div>
        {waiting ? (
          <span className="hidden shrink-0 text-sm font-medium text-brand-700 sm:inline">Review and sign</span>
        ) : null}
        <ChevronRight className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden />
      </Link>
    </li>
  );
}

function DateText({ label, value }: { label: string; value: Date }) {
  return (
    <span>
      {label} <time dateTime={value.toISOString()}>{formatDate(value)}</time>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-line bg-bg-surface px-6 py-12 text-center">
      <FileSignature className="mx-auto h-8 w-8 text-ink-disabled" aria-hidden />
      <h2 className="mt-3 text-base font-semibold text-ink">No signature requests yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-ink-muted">
        When you are asked to sign a document, it will show up here.
      </p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div role="status">
      <span className="sr-only">Loading signature requests</span>
      <ul className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-3 rounded-lg border border-line bg-bg-surface p-4">
            <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
