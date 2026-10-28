'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { ApiError } from '@botss/api-client';
import type {
  AddDocumentAccessInput,
  DocumentAccess,
  DocumentAccessList,
  DocumentShareTargets,
  UpdateDocumentAccessInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

export const documentAccessRootKey = ['document-access'] as const;
export const documentAccessKey = (docId: string) => [...documentAccessRootKey, docId] as const;

/** Clients (and their portal people) a document can be shared with. */
export const documentShareTargetsRootKey = ['document-share-targets'] as const;
export const documentShareTargetsKey = (docId: string) =>
  [...documentShareTargetsRootKey, docId] as const;

export function useDocumentAccess(docId: string | null | undefined) {
  return useQuery({
    queryKey: documentAccessKey(docId ?? '__none__'),
    queryFn: () => getApi().documents.listAccess(docId as string),
    enabled: !!docId,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** Patch the cached access list optimistically without invalidating. */
function patchList(
  qc: ReturnType<typeof useQueryClient>,
  docId: string,
  fn: (prev: DocumentAccessList | undefined) => DocumentAccessList | undefined,
): DocumentAccessList | undefined {
  const prev = qc.getQueryData<DocumentAccessList>(documentAccessKey(docId));
  const next = fn(prev);
  if (next) qc.setQueryData<DocumentAccessList>(documentAccessKey(docId), next);
  return prev;
}

/** A person grant can flip a client person's box in the client portal list. */
function refreshShareTargets(qc: QueryClient, docId: string) {
  return qc.invalidateQueries({ queryKey: documentShareTargetsKey(docId) });
}

export function useAddDocumentAccess(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't share document" },
    mutationFn: (input: AddDocumentAccessInput) => getApi().documents.addAccess(docId, input),
    onSuccess: (server) => {
      // Replace any existing grant for this user (upsert semantics) so a
      // permission change for an existing grantee shows immediately.
      patchList(qc, docId, (curr) => {
        if (!curr) return curr;
        const withoutDupe = curr.items.filter((g) => g.userId !== server.userId);
        return { ...curr, items: [...withoutDupe, server] };
      });
      void refreshShareTargets(qc, docId);
    },
  });
}

export function useUpdateDocumentAccess(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't change access" },
    mutationFn: ({ userId, input }: { userId: string; input: UpdateDocumentAccessInput }) =>
      getApi().documents.updateAccess(docId, userId, input),
    onMutate: async ({ userId, input }) => {
      await qc.cancelQueries({ queryKey: documentAccessKey(docId) });
      const previous = patchList(qc, docId, (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          items: curr.items.map((g) =>
            g.userId === userId ? { ...g, permission: input.permission } : g,
          ),
        };
      });
      return { previous };
    },
    onSuccess: (server: DocumentAccess) => {
      patchList(qc, docId, (curr) => {
        if (!curr) return curr;
        return {
          ...curr,
          items: curr.items.map((g) => (g.userId === server.userId ? server : g)),
        };
      });
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(documentAccessKey(docId), ctx.previous);
      toastError(err, "Couldn't update access");
    },
  });
}

export function useRemoveDocumentAccess(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't remove access" },
    mutationFn: (userId: string) => getApi().documents.removeAccess(docId, userId),
    onMutate: async (userId) => {
      await qc.cancelQueries({ queryKey: documentAccessKey(docId) });
      const previous = patchList(qc, docId, (curr) => {
        if (!curr) return curr;
        return { ...curr, items: curr.items.filter((g) => g.userId !== userId) };
      });
      return { previous };
    },
    onSuccess: () => {
      void refreshShareTargets(qc, docId);
    },
    onError: (err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(documentAccessKey(docId), ctx.previous);
      toastError(err, "Couldn't remove access");
    },
  });
}

// ---------------------------------------------------------------------------
// Client portal sharing: a whole client company, or its people one by one
// ---------------------------------------------------------------------------

type ShareTargetClient = DocumentShareTargets['clients'][number];

export function useDocumentShareTargets(docId: string | null | undefined) {
  return useQuery({
    queryKey: documentShareTargetsKey(docId ?? '__none__'),
    queryFn: () => getApi().documents.shareTargets(docId as string),
    enabled: !!docId,
    // Portal people change on the client page, so refetch on open when stale.
    staleTime: 30_000,
  });
}

/**
 * The share dialog's client portal section. `clients` is who this person may
 * share with; the API answers 403 when they may not manage sharing at all
 * (only the document owner and workspace admins may). `otherShares` are
 * whole-company shares missing from that list, e.g. one an admin made for a
 * client this person cannot pick, so the dialog never hides a live share.
 */
export function useClientPortalSharing(docId: string) {
  const targets = useDocumentShareTargets(docId);
  const access = useDocumentAccess(docId);
  const clients = targets.data?.clients;
  const clientShares = access.data?.clientShares;

  const otherShares = useMemo(() => {
    const listed = new Set((clients ?? []).map((c) => c.id));
    return (clientShares ?? []).filter((s) => !listed.has(s.clientId));
  }, [clients, clientShares]);

  const forbidden = targets.error instanceof ApiError && targets.error.status === 403;
  return {
    clients: clients ?? [],
    otherShares,
    canShare: targets.isSuccess,
    forbidden,
    isLoading: targets.isLoading,
    isError: targets.isError && !forbidden,
    retry: () => void targets.refetch(),
  };
}

function patchTargets(
  qc: QueryClient,
  docId: string,
  fn: (client: ShareTargetClient) => ShareTargetClient,
): DocumentShareTargets | undefined {
  const previous = qc.getQueryData<DocumentShareTargets>(documentShareTargetsKey(docId));
  if (previous) {
    qc.setQueryData<DocumentShareTargets>(documentShareTargetsKey(docId), {
      ...previous,
      clients: previous.clients.map(fn),
    });
  }
  return previous;
}

/** After any client portal share change, reload both lists from the API. */
function refreshSharing(qc: QueryClient, docId: string) {
  return Promise.all([
    refreshShareTargets(qc, docId),
    qc.invalidateQueries({ queryKey: documentAccessKey(docId) }),
  ]);
}

/** Share with, or stop sharing with, everyone at one client. */
export function useSetDocumentClientShare(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update client sharing" },
    mutationFn: async ({ clientId, shared }: { clientId: string; shared: boolean }) => {
      if (shared) await getApi().documents.addClientShare(docId, { clientId });
      else await getApi().documents.removeClientShare(docId, clientId);
    },
    onMutate: async ({ clientId, shared }) => {
      await Promise.all([
        qc.cancelQueries({ queryKey: documentShareTargetsKey(docId) }),
        qc.cancelQueries({ queryKey: documentAccessKey(docId) }),
      ]);
      const previous = patchTargets(qc, docId, (c) =>
        c.id === clientId ? { ...c, companyShared: shared } : c,
      );
      // Unsharing also drops the row from the access list's company shares,
      // which the dialog lists for clients outside the pickable set.
      const previousAccess = shared
        ? undefined
        : patchList(qc, docId, (curr) =>
            curr
              ? { ...curr, clientShares: curr.clientShares?.filter((s) => s.clientId !== clientId) }
              : curr,
          );
      return { previous, previousAccess };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(documentShareTargetsKey(docId), ctx.previous);
      if (ctx?.previousAccess) qc.setQueryData(documentAccessKey(docId), ctx.previousAccess);
      toastError(err, "Couldn't update sharing with this client");
    },
    onSettled: () => refreshSharing(qc, docId),
  });
}

/**
 * Share with one person at a client, or stop. Always READ: the API refuses
 * anything else for client people.
 */
export function useSetClientPersonAccess(docId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't update sharing" },
    mutationFn: async ({ userId, shared }: { userId: string; shared: boolean }) => {
      if (shared) await getApi().documents.addAccess(docId, { userId, permission: 'READ' });
      else await getApi().documents.removeAccess(docId, userId);
    },
    onMutate: async ({ userId, shared }) => {
      await qc.cancelQueries({ queryKey: documentShareTargetsKey(docId) });
      const previous = patchTargets(qc, docId, (c) => ({
        ...c,
        people: c.people.map((p) => (p.userId === userId ? { ...p, hasAccess: shared } : p)),
      }));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(documentShareTargetsKey(docId), ctx.previous);
      toastError(err, "Couldn't update sharing with this person");
    },
    onSettled: () => refreshSharing(qc, docId),
  });
}
