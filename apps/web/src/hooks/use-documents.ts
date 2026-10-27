'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDocumentInput,
  DocumentWithCreator,
  ListDocumentsQuery,
  SharePublicLinkInput,
  UpdateDocumentInput,
} from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

const documentsKey = (q?: Partial<ListDocumentsQuery>) => ['documents', q ?? {}] as const;

type DocumentListPage = { items: DocumentWithCreator[] } & Record<string, unknown>;

function patchDocumentInCaches(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  patch: Partial<DocumentWithCreator>,
): Array<[readonly unknown[], DocumentListPage | undefined]> {
  const snapshots = qc.getQueriesData<DocumentListPage>({ queryKey: ['documents'] });
  for (const [key, data] of snapshots) {
    if (!data?.items) continue;
    qc.setQueryData<DocumentListPage>(key, {
      ...data,
      items: data.items.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    });
  }
  return snapshots;
}

function restoreDocumentCaches(
  qc: ReturnType<typeof useQueryClient>,
  snapshots: Array<[readonly unknown[], DocumentListPage | undefined]>,
): void {
  for (const [key, data] of snapshots) qc.setQueryData(key, data);
}

export function useDocuments(q?: Partial<ListDocumentsQuery>) {
  return useQuery({
    queryKey: documentsKey(q),
    queryFn: () => getApi().documents.list(q),
    // The editor owns the document state while the page is open. Letting the
    // list refetch - and overwrite items[].content with the server's freshly
    // normalized JSON - recreates the SELECT→UPDATE pump (the "documents
    // editor save loop"). Hold the cache steady.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useCreateDocument() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't create document" },
    mutationFn: (input: CreateDocumentInput) => getApi().documents.create(input),
    onSuccess: (created) => {
      // Insert at the top of every cached list page so the new doc shows up
      // immediately. We can't invalidate - the docs cache is held steady to
      // protect the editor's mount-time content contract.
      const snapshots = qc.getQueriesData<DocumentListPage>({ queryKey: ['documents'] });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData<DocumentListPage>(key, {
          ...data,
          items: [created as unknown as DocumentWithCreator, ...data.items],
        });
      }
    },
  });
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't save document" },
    mutationFn: ({ id, input }: { id: string; input: UpdateDocumentInput }) =>
      getApi().documents.update(id, input),
    // Optimistic update of every cached `['documents', ...]` list query so
    // the UI reflects edits without a refetch. We intentionally DO NOT
    // invalidate on success - invalidation would refetch the list, replace
    // each item's `content` with the server's freshly parsed JSON, and feed
    // it back into the editor on the next render. That was the loop.
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: ['documents'] });
      const snapshots = patchDocumentInCaches(qc, id, input as Partial<DocumentWithCreator>);
      return { snapshots };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.snapshots) restoreDocumentCaches(qc, ctx.snapshots);
      toastError(err, "Couldn't save document");
    },
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't delete document" },
    mutationFn: (id: string) => getApi().documents.remove(id),
    // Optimistically drop the row from every cached list page so the sidebar
    // updates instantly. Restore on error.
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['documents'] });
      const snapshots = qc.getQueriesData<DocumentListPage>({ queryKey: ['documents'] });
      for (const [key, data] of snapshots) {
        if (!data?.items) continue;
        qc.setQueryData<DocumentListPage>(key, {
          ...data,
          items: data.items.filter((d) => d.id !== id),
        });
      }
      return { snapshots };
    },
    onError: (err, _id, ctx) => {
      if (ctx?.snapshots) restoreDocumentCaches(qc, ctx.snapshots);
      toastError(err, "Couldn't delete document");
    },
    onSuccess: () => toast.success('Document deleted.'),
  });
}

export function useShareDocument() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't share document" },
    mutationFn: ({ id, input }: { id: string; input: SharePublicLinkInput }) =>
      getApi().documents.share(id, input),
    onSuccess: (updated) => {
      // The server-generated `publicSlug` lands here; merge into every cached
      // list so the share dialog can read it back without a refetch.
      patchDocumentInCaches(qc, updated.id, updated as Partial<DocumentWithCreator>);
    },
  });
}

export function useUnshareDocument() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorTitle: "Couldn't stop sharing document" },
    mutationFn: (id: string) => getApi().documents.unshare(id),
    // Drop `publicSlug` optimistically so the share dialog flips state
    // immediately. `visibility` is intentionally NOT patched here - the
    // server derives the next visibility from `projectId`; the onSuccess
    // handler below merges the authoritative value back into the cache.
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['documents'] });
      const snapshots = patchDocumentInCaches(qc, id, { publicSlug: null });
      return { snapshots };
    },
    onSuccess: (updated) => {
      patchDocumentInCaches(qc, updated.id, updated as Partial<DocumentWithCreator>);
    },
    onError: (err, _id, ctx) => {
      if (ctx?.snapshots) restoreDocumentCaches(qc, ctx.snapshots);
      toastError(err, "Couldn't revoke public link");
    },
  });
}
