'use client';

import {
  Banknote,
  Building2,
  DoorClosed,
  DoorOpen,
  FilePlus2,
  FileSignature,
  FileText,
  FolderPlus,
  Handshake,
  type LucideIcon,
  Receipt,
  Share2,
  ShieldCheck,
  UserCog,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import type { ClientActivityItem, ClientActivityKind } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { QueryError } from '@/components/ui/query-error';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { activityHref, activityVerb, useClientActivity } from '@/hooks/use-client-activity';
import { absoluteTime, relativeTime } from '@/lib/time';

const KIND_ICON: Record<ClientActivityKind, LucideIcon> = {
  CLIENT_CREATED: Building2,
  LEAD_CONVERTED: UserPlus,
  PROJECT_CREATED: FolderPlus,
  DOCUMENT_FILED: FilePlus2,
  DOCUMENT_SHARED: Share2,
  PORTAL_INVITED: DoorOpen,
  PORTAL_REVOKED: DoorClosed,
  PORTAL_ROLE_CHANGED: UserCog,
  SIGNATURE_SENT: FileSignature,
  SIGNATURE_COMPLETED: ShieldCheck,
  INVOICE_ISSUED: Receipt,
  PAYMENT_RECEIVED: Banknote,
  CONTRACT_CREATED: Handshake,
};

/** Everything that happened around a client, newest first. */
export function ClientActivityFeed({ clientId }: { clientId: string }) {
  const feed = useClientActivity(clientId);

  if (feed.isLoading) {
    return (
      <div className="space-y-2" aria-busy>
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
        <Skeleton className="h-14" />
      </div>
    );
  }

  if (feed.isError && feed.items.length === 0) {
    return (
      <QueryError message="Couldn't load the activity feed." onRetry={() => void feed.refetch()} />
    );
  }

  if (feed.items.length === 0) {
    return (
      <div className="border-line rounded-lg border border-dashed bg-white p-10 text-center">
        <p className="text-ink text-sm font-medium">Nothing has happened here yet.</p>
        <p className="text-ink-muted mt-1 text-sm">
          New projects, documents, portal invites and signatures will show up here.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="Client activity" className="space-y-3">
      <ol className="divide-line border-line divide-y rounded-lg border bg-white">
        {feed.items.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </ol>
      {feed.isFetchNextPageError ? (
        <QueryError
          compact
          message="Couldn't load older activity."
          onRetry={() => void feed.fetchNextPage()}
        />
      ) : null}
      {feed.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? 'Loading...' : 'Load older activity'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({ item }: { item: ClientActivityItem }) {
  const Icon = KIND_ICON[item.kind] ?? FileText;
  const href = activityHref(item);
  return (
    <li className="flex items-start gap-3 p-3">
      <span className="bg-bg-subtle text-ink-muted mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ink text-sm">
          <span className="font-medium">{activityVerb(item.kind)}</span>
          {item.title ? (
            <>
              {': '}
              {href ? (
                <Link
                  href={href}
                  className="text-brand-700 focus-visible:shadow-focus break-words rounded hover:underline focus-visible:outline-none"
                >
                  {item.title}
                </Link>
              ) : (
                <span className="break-words">{item.title}</span>
              )}
            </>
          ) : null}
        </p>
        <p className="text-ink-muted mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          {item.actor ? <span>by {item.actor.name}</span> : null}
          {item.detail ? <span className="break-all">{item.detail}</span> : null}
        </p>
      </div>
      <Tooltip content={absoluteTime(item.at)}>
        <time
          dateTime={new Date(item.at).toISOString()}
          className="text-ink-muted shrink-0 whitespace-nowrap text-xs"
        >
          {relativeTime(item.at)}
        </time>
      </Tooltip>
    </li>
  );
}
