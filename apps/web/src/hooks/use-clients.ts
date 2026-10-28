'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Client,
  ClientDetail,
  ClientWithOwner,
  CreateClientInput,
  ListClientsQuery,
  UpdateClientInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { findCachedUser } from '@/lib/member-cache';
import { toastError } from '@/lib/toast';

const clientsKey = (q?: Partial<ListClientsQuery>) => ['clients', q ?? {}] as const;
const clientKey = (id: string) => ['clients', id] as const;

type ClientListPage = { items: ClientWithOwner[] } & Record<string, unknown>;

/**
 * Resolve a user id into the summary shape the rows carry, falling back to a
 * name-less placeholder so a cache miss renders an avatar rather than a hole.
 */
function resolveUser(
  qc: ReturnType<typeof useQueryClient>,
  userId: string | null,
  previous: ClientWithOwner['owner'] = null,
): ClientWithOwner['owner'] {
  if (userId == null) return null;
  const fromMembers = findCachedUser(qc, userId);
  if (fromMembers) return fromMembers;
  if (previous && previous.id === userId) return previous;
  return { id: userId, name: '', email: '', image: null };
}

function snapshotPages(qc: ReturnType<typeof useQueryClient>) {
  return qc.getQueriesData<ClientListPage>({ queryKey: ['clients'] });
}

function patchListPages(
  qc: ReturnType<typeof useQueryClient>,
  clientId: string,
  patch: (c: ClientWithOwner) => ClientWithOwner,
) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    // The single-client query (['clients', id]) shares the prefix; skip it.
    if (typeof (key as unknown[])[1] === 'string') continue;
    qc.setQueryData<ClientListPage>(key, {
      ...data,
      items: data.items.map((c) => (c.id === clientId ? patch(c) : c)),
    });
  }
  return pages;
}

function removeFromListPages(qc: ReturnType<typeof useQueryClient>, clientId: string) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    if (typeof (key as unknown[])[1] === 'string') continue;
    qc.setQueryData<ClientListPage>(key, {
      ...data,
      items: data.items.filter((c) => c.id !== clientId),
    });
  }
  return pages;
}

function restorePages(
  qc: ReturnType<typeof useQueryClient>,
  pages: ReturnType<typeof snapshotPages>,
) {
  for (const [key, data] of pages) qc.setQueryData(key, data);
}

export function useClients(q?: Partial<ListClientsQuery>) {
  return useQuery({
    queryKey: clientsKey(q),
    queryFn: () => getApi().clients.list(q),
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useClient(id: string) {
  return useQuery({
    queryKey: clientKey(id),
    queryFn: () => getApi().clients.get(id),
    enabled: !!id,
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create client" },
    mutationFn: (input: CreateClientInput) => getApi().clients.create(input),
    onSuccess: (created) => {
      // Synthesize the wrapped row from cached users so the new client surfaces
      // with the same shape the list endpoint would return.
      const wrapped: ClientWithOwner = {
        ...created,
        owner: resolveUser(qc, created.createdById),
        assignee: resolveUser(qc, created.assigneeId),
      };
      const pages = snapshotPages(qc);
      for (const [key, data] of pages) {
        if (!data?.items) continue;
        if (typeof (key as unknown[])[1] === 'string') continue;
        qc.setQueryData<ClientListPage>(key, {
          ...data,
          items: [wrapped, ...data.items],
        });
      }
    },
  });
}

/**
 * Apply an UpdateClientInput patch on top of a cached client row, mapping
 * `undefined` → keep, all other values overwrite. Generic so the same helper
 * patches both the list-page shape (ClientWithOwner) and the detail-cache
 * shape (ClientDetail) - extra fields ride through the spread untouched.
 */
function applyClientPatch<T extends ClientWithOwner>(
  prev: T,
  input: UpdateClientInput,
  cachedAssignee?: ClientWithOwner['owner'],
): T {
  const next: T = { ...prev };
  if (input.name !== undefined) next.name = input.name;
  if (input.legalName !== undefined) next.legalName = input.legalName ?? null;
  if (input.email !== undefined) next.email = input.email ?? null;
  if (input.phone !== undefined) next.phone = input.phone ?? null;
  if (input.website !== undefined) next.website = input.website ?? null;
  if (input.industry !== undefined) next.industry = input.industry ?? null;
  if (input.status !== undefined) next.status = input.status;
  if (input.addressLine1 !== undefined) next.addressLine1 = input.addressLine1 ?? null;
  if (input.addressLine2 !== undefined) next.addressLine2 = input.addressLine2 ?? null;
  if (input.city !== undefined) next.city = input.city ?? null;
  if (input.state !== undefined) next.state = input.state ?? null;
  if (input.postalCode !== undefined) next.postalCode = input.postalCode ?? null;
  if (input.country !== undefined) next.country = input.country ?? null;
  if (input.taxId !== undefined) next.taxId = input.taxId ?? null;
  if (input.notes !== undefined) next.notes = input.notes ?? null;
  if (input.tags !== undefined) next.tags = input.tags;
  if (input.assigneeId !== undefined) {
    next.assigneeId = input.assigneeId ?? null;
    next.assignee = input.assigneeId == null ? null : (cachedAssignee ?? prev.assignee);
  }
  next.updatedAt = new Date();
  return next;
}

export function useUpdateClient() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save client" },
    mutationFn: ({ id, input }: { id: string; input: UpdateClientInput }) =>
      getApi().clients.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['clients'] });
      const cachedAssignee =
        input.assigneeId != null ? (findCachedUser(qc, input.assigneeId) ?? null) : undefined;

      // Patch the single-client cache used by the detail page. The detail
      // shape is a superset of ClientWithOwner; applyClientPatch is generic
      // so the extra fields (convertedFromLead) ride through untouched.
      const previousSingle = qc.getQueryData<ClientDetail>(clientKey(id));
      if (previousSingle) {
        qc.setQueryData<ClientDetail>(
          clientKey(id),
          applyClientPatch(previousSingle, input, cachedAssignee),
        );
      }
      // Patch every list page that contains this client.
      const pages = patchListPages(qc, id, (c) => applyClientPatch(c, input, cachedAssignee));
      return { previousSingle, pages };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.previousSingle !== undefined) {
        qc.setQueryData(clientKey(vars.id), ctx.previousSingle);
      }
      if (ctx?.pages) restorePages(qc, ctx.pages);
      toastError(err, "Couldn't save client");
    },
  });
}

export function useDeleteClient() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete client" },
    mutationFn: (id: string) => getApi().clients.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['clients'] });
      const pages = removeFromListPages(qc, id);
      const previousSingle = qc.getQueryData<ClientDetail>(clientKey(id));
      qc.removeQueries({ queryKey: clientKey(id) });
      return { pages, previousSingle };
    },
    onError: (err, id, ctx) => {
      if (ctx?.pages) restorePages(qc, ctx.pages);
      if (ctx?.previousSingle) qc.setQueryData(clientKey(id), ctx.previousSingle);
      toastError(err, "Couldn't delete client");
    },
  });
}

/**
 * Re-export for callers that want to construct an optimistic Client shape
 * without depending on the internal hook (e.g. a future bulk-import flow).
 */
export type { Client };
