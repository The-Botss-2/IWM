'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConvertLeadInput,
  CreateLeadInput,
  Lead,
  LeadWithOwner,
  ListLeadsQuery,
  UpdateLeadInput,
} from '@botss/shared-types';

import { useSalesAccess } from '@/hooks/use-sales-access';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { getApi } from '@/lib/api';
import { findCachedUser } from '@/lib/member-cache';
import { toastError } from '@/lib/toast';

const leadsKey = (q?: Partial<ListLeadsQuery>) => ['leads', q ?? {}] as const;

type LeadListPage = { items: LeadWithOwner[] } & Record<string, unknown>;

function snapshotPages(qc: ReturnType<typeof useQueryClient>) {
  return qc.getQueriesData<LeadListPage>({ queryKey: ['leads'] });
}

function patchEvery(
  qc: ReturnType<typeof useQueryClient>,
  leadId: string,
  patch: (l: LeadWithOwner) => LeadWithOwner,
) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    qc.setQueryData<LeadListPage>(key, {
      ...data,
      items: data.items.map((l) => (l.id === leadId ? patch(l) : l)),
    });
  }
  return pages;
}

function removeEverywhere(qc: ReturnType<typeof useQueryClient>, leadId: string) {
  const pages = snapshotPages(qc);
  for (const [key, data] of pages) {
    if (!data?.items) continue;
    qc.setQueryData<LeadListPage>(key, {
      ...data,
      items: data.items.filter((l) => l.id !== leadId),
    });
  }
  return pages;
}

function restore(qc: ReturnType<typeof useQueryClient>, pages: ReturnType<typeof snapshotPages>) {
  for (const [key, data] of pages) qc.setQueryData(key, data);
}

export function useLeads(q?: Partial<ListLeadsQuery>) {
  return useQuery({
    queryKey: leadsKey(q),
    queryFn: () => getApi().leads.list(q),
    // Pipeline owns lead positioning while the page is open. Refetching after
    // every drag-stage-change would feed new updatedAt values into dnd-kit's
    // sortable strategy mid-animation, the same SELECT→UPDATE pump that
    // bit us on the tasks kanban.
    staleTime: 30_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

const workspaceLeadsKey = (wsId: string) => ['ws-leads', wsId] as const;

/**
 * Workspace dashboard lead list, shared by the KPI strip's "Open leads" tile
 * and the lead-funnel widget (one fetch for both). Gated on sales access so
 * users without it never fire a guaranteed-403 request; `canSeeLeads` lets
 * callers hide their UI in that case.
 */
export function useWorkspaceLeads() {
  const ws = useCurrentWorkspace();
  const wsId = ws.data?.id ?? '';
  const canSeeLeads = useSalesAccess().leads;
  const query = useQuery({
    queryKey: workspaceLeadsKey(wsId),
    queryFn: () => getApi().leads.list({ pageSize: 1000 }),
    enabled: !!wsId && canSeeLeads,
    staleTime: 60_000,
  });
  return { ...query, canSeeLeads };
}

/** Leads not yet in a terminal (WON / LOST) stage. */
export function countOpenLeads(leads: readonly Pick<Lead, 'stage'>[]): number {
  return leads.filter((l) => l.stage !== 'WON' && l.stage !== 'LOST').length;
}

/**
 * Resolve a user id into the summary shape the list rows carry, falling back to
 * a name-less placeholder so a cache miss renders an avatar rather than a hole.
 */
function resolveUser(
  qc: ReturnType<typeof useQueryClient>,
  userId: string | null,
  previous: LeadWithOwner['owner'] = null,
): LeadWithOwner['owner'] {
  if (userId == null) return null;
  const fromMembers = findCachedUser(qc, userId);
  if (fromMembers) return fromMembers;
  if (previous && previous.id === userId) return previous;
  return { id: userId, name: '', email: '', image: null };
}

/**
 * The list-response shape wraps `Lead` with two users - `owner` (the creator)
 * and `assignee`; mutation responses use the bare `Lead` shape. We synthesize
 * the wrapped row from cache so the pipeline doesn't lose either on an
 * optimistic update.
 */
function attachPeople(
  qc: ReturnType<typeof useQueryClient>,
  base: Lead,
  previous: Pick<LeadWithOwner, 'owner' | 'assignee'> | null = null,
): LeadWithOwner {
  return {
    ...base,
    owner: resolveUser(qc, base.createdById, previous?.owner ?? null),
    assignee: resolveUser(qc, base.assigneeId, previous?.assignee ?? null),
  };
}

export function useCreateLead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create lead" },
    mutationFn: (input: CreateLeadInput) => getApi().leads.create(input),
    onSuccess: (created) => {
      const wrapped = attachPeople(qc, created);
      const pages = snapshotPages(qc);
      for (const [key, data] of pages) {
        if (!data?.items) continue;
        qc.setQueryData<LeadListPage>(key, {
          ...data,
          items: [wrapped, ...data.items],
        });
      }
    },
  });
}

export function useUpdateLead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save lead" },
    mutationFn: ({ id, input }: { id: string; input: UpdateLeadInput }) =>
      getApi().leads.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['leads'] });
      const pages = patchEvery(qc, id, (l) => {
        const next: LeadWithOwner = { ...l };
        if (input.name !== undefined) next.name = input.name;
        if (input.email !== undefined) next.email = input.email ?? null;
        if (input.phone !== undefined) next.phone = input.phone ?? null;
        if (input.company !== undefined) next.company = input.company ?? null;
        if (input.jobTitle !== undefined) next.jobTitle = input.jobTitle ?? null;
        if (input.source !== undefined) next.source = input.source;
        if (input.stage !== undefined) next.stage = input.stage;
        if (input.estimatedValue !== undefined) next.estimatedValue = input.estimatedValue ?? null;
        if (input.currency !== undefined) next.currency = input.currency;
        if (input.notes !== undefined) next.notes = input.notes ?? null;
        if (input.tags !== undefined) next.tags = input.tags;
        if (input.assigneeId !== undefined) {
          next.assigneeId = input.assigneeId ?? null;
          next.assignee = resolveUser(qc, input.assigneeId ?? null, next.assignee);
        }
        next.updatedAt = new Date();
        return next;
      });
      return { pages };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't save changes");
    },
  });
}

export function useDeleteLead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete lead" },
    mutationFn: (id: string) => getApi().leads.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['leads'] });
      const pages = removeEverywhere(qc, id);
      return { pages };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't delete lead");
    },
  });
}

export function useConvertLead() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't convert lead" },
    mutationFn: ({ id, input }: { id: string; input: ConvertLeadInput }) =>
      getApi().leads.convert(id, input),
    onMutate: async ({ id }) => {
      // Optimistically flip the lead to WON in the pipeline so the column
      // animates immediately. We don't know the new clientId until the server
      // responds, so we record but don't write `convertedToClientId` yet.
      await qc.cancelQueries({ queryKey: ['leads'] });
      const pages = patchEvery(qc, id, (l) => ({
        ...l,
        stage: 'WON',
        convertedAt: l.convertedAt ?? new Date(),
        updatedAt: new Date(),
      }));
      return { pages };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.pages) restore(qc, ctx.pages);
      toastError(err, "Couldn't convert lead");
    },
  });
}
