'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClientActivityItem, ClientActivityKind } from '@botss/shared-types';

import { getApi } from '@/lib/api';

export const clientActivityKey = (clientId: string) => ['client-hub', clientId, 'activity'] as const;

const PAGE_SIZE = 25;

/** The client's merged activity feed, newest first, paged by cursor. */
export function useClientActivity(clientId: string) {
  const query = useInfiniteQuery({
    queryKey: clientActivityKey(clientId),
    queryFn: ({ pageParam }) =>
      getApi().clients.activity(clientId, {
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: !!clientId,
    staleTime: 30_000,
  });
  const items: ClientActivityItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, items };
}

const ACTIVITY_VERB: Record<ClientActivityKind, string> = {
  CLIENT_CREATED: 'Client created',
  LEAD_CONVERTED: 'Converted from lead',
  PROJECT_CREATED: 'Project created',
  DOCUMENT_FILED: 'Document filed',
  DOCUMENT_SHARED: 'Document shared with the client',
  PORTAL_INVITED: 'Invited to the portal',
  PORTAL_REVOKED: 'Portal access removed',
  PORTAL_ROLE_CHANGED: 'Portal role changed',
  SIGNATURE_SENT: 'Sent for signature',
  SIGNATURE_COMPLETED: 'Signatures completed',
  INVOICE_ISSUED: 'Invoice issued',
  PAYMENT_RECEIVED: 'Payment received',
  CONTRACT_CREATED: 'Contract created',
};

export function activityVerb(kind: ClientActivityKind): string {
  return ACTIVITY_VERB[kind];
}

/**
 * Where an activity item leads, if anywhere. Only entities with a staff page
 * of their own get a link; the rest render as plain text.
 */
export function activityHref(item: ClientActivityItem): string | null {
  const e = item.entity;
  if (!e) return null;
  const id = encodeURIComponent(e.id);
  switch (e.type) {
    case 'project':
      return `/projects/${id}`;
    case 'document':
      return `/documents?doc=${id}`;
    case 'invoice':
      return `/financials/invoices/${id}`;
    case 'contract':
      return `/financials/${id}`;
    default:
      return null;
  }
}
