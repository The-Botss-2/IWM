'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { CreateSupportGrantInput, SupportSessionInfo } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { getApi } from '@/lib/api';
import {
  getSupportSession,
  leaveSupportSession,
  openSupportSession,
  subscribeSupportSession,
} from '@/lib/support-session';

/**
 * Support access. Org admins grant, list and revoke (Settings, Support
 * access); platform operators open a read only support session on an active
 * grant (Organizations page). The server is authoritative for every rule.
 */

const grantsKey = ['support', 'grants'] as const;
const activeGrantsKey = ['support', 'active-grants'] as const;

export function useSupportGrants(enabled = true) {
  return useQuery({
    queryKey: grantsKey,
    queryFn: () => getApi().support.listGrants(),
    enabled,
    staleTime: 15_000,
  });
}

export function useCreateSupportGrant(options: { onSuccess?: () => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't grant support access", successMessage: 'Support access granted' },
    mutationFn: (input: CreateSupportGrantInput) => getApi().support.createGrant(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: grantsKey });
      options.onSuccess?.();
    },
  });
}

export function useRevokeSupportGrant() {
  const qc = useQueryClient();
  return useMutation({
    meta: {
      errorTitle: "Couldn't revoke support access",
      successMessage: 'Support access revoked',
    },
    mutationFn: (grantId: string) => getApi().support.revokeGrant(grantId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: grantsKey }),
  });
}

/** Platform operator: active grants, keyed by organization id. */
export function useActiveSupportGrants(enabled = true) {
  return useQuery({
    queryKey: activeGrantsKey,
    queryFn: () => getApi().support.listActiveGrants(),
    enabled,
    staleTime: 15_000,
    // The server sends one grant per organization (the latest ending); keep
    // the first per organization anyway so a repeat never wins over it.
    select: (data) => {
      const byOrg = new Map<string, (typeof data.items)[number]>();
      for (const g of data.items) if (!byOrg.has(g.organizationId)) byOrg.set(g.organizationId, g);
      return byOrg;
    },
  });
}

/** Platform operator: open a support session, then reload inside the org. */
export function useStartSupportSession() {
  return useMutation({
    meta: { errorTitle: "Couldn't open the support session" },
    mutationFn: (grantId: string) => getApi().support.startSession(grantId),
    onSuccess: (session) => openSupportSession(session),
  });
}

/**
 * The support session this request runs in: the server's answer on
 * `/auth/me` when present, else this tab's stored session (an API build
 * without the field). Null outside a support session.
 */
export function useActiveSupportSession(): SupportSessionInfo | null {
  const session = useSessionContext();
  const local = useSyncExternalStore(subscribeSupportSession, getSupportSession, () => null);
  if (session.data?.support) return session.data.support;
  return local;
}

/** Leave the support session (Exit button). */
export function exitSupportSession(): void {
  leaveSupportSession();
}

/**
 * True when the app just left a support session because the server ended it
 * (`?support=ended`, set by `leaveSupportSession`). Read after mount, so the
 * page needs no Suspense boundary for search params.
 */
export function useSupportEndedNotice(): boolean {
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    try {
      setEnded(new URLSearchParams(window.location.search).get('support') === 'ended');
    } catch {
      setEnded(false);
    }
  }, []);
  return ended;
}
