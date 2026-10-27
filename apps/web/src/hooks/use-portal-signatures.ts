'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { PortalSignatureItem, PortalSignatureList } from '@botss/shared-types';

import { getApi } from '@/lib/api';

/** Everything the portal caches for one client sits under this prefix. */
const portalClientKey = (clientId: string) => ['portal', clientId] as const;
const portalSignaturesKey = (clientId: string) => ['portal', clientId, 'signatures'] as const;

/**
 * Where one request stands for the signed-in person. A closed request's end
 * state wins over the person's own answer, except their decline.
 */
export type PortalSignatureState =
  /** Open, and the person has not opened it yet. */
  | 'new'
  /** Open, opened but not answered. */
  | 'opened'
  /** Open, the person signed and others still have to. */
  | 'signed'
  /** Everyone signed; the sealed PDF can be downloaded. */
  | 'completed'
  /** The person declined. */
  | 'declined'
  /** Another signer declined, so the request closed. */
  | 'closed'
  | 'expired';

export function portalSignatureState(item: PortalSignatureItem): PortalSignatureState {
  switch (item.requestStatus) {
    case 'COMPLETED':
      return 'completed';
    case 'EXPIRED':
      return 'expired';
    case 'SENT':
      if (item.signerStatus === 'SIGNED') return 'signed';
      // A decline closes the request, so this is only a race with the list.
      if (item.signerStatus === 'DECLINED') return 'declined';
      return item.signerStatus === 'VIEWED' ? 'opened' : 'new';
    default:
      // DECLINED. The list never returns drafts or cancelled requests.
      return item.signerStatus === 'DECLINED' ? 'declined' : 'closed';
  }
}

/** Open, and this person has not signed or declined yet. */
function isWaitingForSigner(item: PortalSignatureItem): boolean {
  const state = portalSignatureState(item);
  return state === 'new' || state === 'opened';
}

export interface PortalSignatureGroups {
  /** Waiting for this person, soonest deadline first. */
  waiting: PortalSignatureItem[];
  /** Signed, declined, completed or expired, newest first (the API's order). */
  past: PortalSignatureItem[];
  total: number;
}

function groupPortalSignatures(list: PortalSignatureList): PortalSignatureGroups {
  const waiting: PortalSignatureItem[] = [];
  const past: PortalSignatureItem[] = [];
  for (const item of list.items) {
    (isWaitingForSigner(item) ? waiting : past).push(item);
  }
  waiting.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  return { waiting, past, total: list.items.length };
}

/** Signature requests addressed to the signed-in person at this client. */
export function usePortalSignatures(clientId: string) {
  return useQuery({
    queryKey: portalSignaturesKey(clientId),
    queryFn: () => getApi().portal.signatures(clientId),
    select: groupPortalSignatures,
    enabled: clientId.length > 0,
  });
}

/**
 * Refresh everything cached for one client, so the signatures list and the
 * overview's pending count catch up after the person signs or declines.
 */
export function useInvalidatePortalClient() {
  const qc = useQueryClient();
  return useCallback(
    (clientId: string) => qc.invalidateQueries({ queryKey: portalClientKey(clientId) }),
    [qc],
  );
}
