'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import type { ClientSignatureItem } from '@botss/shared-types';

import { useAbility } from '@/lib/ability';
import { getApi } from '@/lib/api';

/**
 * Under `['signatures', 'list']` so every signature mutation (send, resend,
 * cancel, retry) refreshes the client's list along with the document ones.
 */
const clientSignaturesKey = (clientId: string) =>
  ['signatures', 'list', 'client', clientId] as const;

const PAGE_SIZE = 20;

/** Signature requests tied to the client, newest first, paged by cursor. */
export function useClientSignatures(clientId: string) {
  // Workspace VIEWER roles cannot read signature requests; skip the 403.
  const canRead = useAbility().can('read', 'SignatureRequest');
  const query = useInfiniteQuery({
    queryKey: clientSignaturesKey(clientId),
    queryFn: ({ pageParam }) =>
      getApi().clients.signatures(clientId, {
        limit: PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? null,
    enabled: !!clientId && canRead,
    staleTime: 30_000,
    retry: 1,
    // Signers act outside the app; poll gently while one is outstanding.
    refetchInterval: (q) =>
      q.state.data?.pages.some((p) => p.items.some((r) => r.status === 'SENT')) ? 60_000 : false,
  });
  const items: ClientSignatureItem[] = query.data?.pages.flatMap((p) => p.items) ?? [];
  return { ...query, items, canRead };
}
