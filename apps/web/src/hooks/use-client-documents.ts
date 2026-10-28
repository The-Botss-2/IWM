'use client';

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createDocumentSchema, type ClientDocumentList, type Document } from '@botss/shared-types';

import { getApi } from '@/lib/api';
import { describeError, toast, toastError, toastErrorMessage } from '@/lib/toast';
import { clientActivityKey } from './use-client-activity';
import { documentAccessKey, documentShareTargetsKey } from './use-document-access';
import { useCreateDocument } from './use-documents';

/**
 * Documents on the client page: filed under the client, living in one of its
 * projects, or shared with it. Kept outside the ['clients'] prefix: client
 * edits cancel every ['clients'] query, which would strand a first load.
 */
const clientDocumentsKey = (clientId: string) => ['client-hub', clientId, 'documents'] as const;

export function useClientDocuments(clientId: string) {
  return useQuery({
    queryKey: clientDocumentsKey(clientId),
    queryFn: () => getApi().clients.documents(clientId),
    enabled: !!clientId,
    staleTime: 30_000,
  });
}

function refreshClientHub(qc: QueryClient, clientId: string) {
  void qc.invalidateQueries({ queryKey: clientDocumentsKey(clientId) });
  void qc.invalidateQueries({ queryKey: clientActivityKey(clientId) });
}

/** Same title rule as the API, checked before the request. */
export function validateDocumentTitle(title: string): string | null {
  const parsed = createDocumentSchema.shape.title.safeParse(title.trim());
  if (parsed.success) return null;
  return title.trim() ? 'Keep the title under 200 characters.' : 'Give the document a title.';
}

export interface CreateClientDocumentResult {
  document: Document;
  /** Asked to share now and that worked. */
  shared: boolean;
  /** Asked to share now but the share failed; the document still exists. */
  shareError: string | null;
}

/**
 * Create a document filed under the client. It is NOT shared with the client
 * unless `shareNow` is set. When the document is created but the share fails,
 * the result says so (and a toast explains it) rather than failing the whole
 * action, since the document already exists.
 */
export function useCreateClientDocument(clientId: string, clientName: string) {
  const qc = useQueryClient();
  // Reuse the documents page hook so the new document also lands in the
  // documents list caches (held steady, never refetched) and opens there.
  const createDoc = useCreateDocument();
  return useMutation({
    // The only failure path is the inner create, which useCreateDocument
    // already toasts - don't let the global handler report it a second time.
    meta: { silentError: true },
    mutationFn: async (input: {
      title: string;
      shareNow: boolean;
    }): Promise<CreateClientDocumentResult> => {
      const document = await createDoc.mutateAsync({
        title: input.title.trim(),
        clientId,
        content: { type: 'doc', content: [] },
      });
      if (!input.shareNow) return { document, shared: false, shareError: null };
      try {
        await getApi().documents.addClientShare(document.id, { clientId });
        return { document, shared: true, shareError: null };
      } catch (err) {
        return {
          document,
          shared: false,
          shareError: describeError(err, 'The share request failed.'),
        };
      }
    },
    onSuccess: (result) => {
      if (result.shareError) {
        toastErrorMessage(
          `"${result.document.title}" was created and filed under ${clientName}, but it couldn't be shared with them: ${result.shareError} Use "Share with client" on the document to try again`,
        );
      } else {
        toast.success(
          result.shared
            ? `Document created and shared with ${clientName}.`
            : `Document created and filed under ${clientName}.`,
        );
      }
    },
    // useCreateDocument already toasts a failed create.
    onSettled: () => refreshClientHub(qc, clientId),
  });
}

/** Share a document with the whole client company, or stop sharing it. */
export function useSetClientDocumentShare(clientId: string) {
  const qc = useQueryClient();
  const key = clientDocumentsKey(clientId);
  return useMutation({
    meta: { errorTitle: "Couldn't update document sharing" },
    mutationFn: async ({ docId, shared }: { docId: string; shared: boolean }) => {
      if (shared) await getApi().documents.addClientShare(docId, { clientId });
      else await getApi().documents.removeClientShare(docId, clientId);
    },
    onMutate: async ({ docId, shared }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<ClientDocumentList>(key);
      if (previous) {
        qc.setQueryData<ClientDocumentList>(key, {
          ...previous,
          items: previous.items.map((d) =>
            d.id === docId ? { ...d, sharedWithClient: shared } : d,
          ),
        });
      }
      return { previous };
    },
    onSuccess: (_data, { shared }) => {
      toast.success(shared ? 'Shared with the client.' : 'No longer shared with the client.');
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
      toastError(err, "Couldn't update sharing with this client");
    },
    onSettled: (_data, _err, { docId }) => {
      refreshClientHub(qc, clientId);
      // The document's own share dialog reads these.
      void qc.invalidateQueries({ queryKey: documentAccessKey(docId) });
      void qc.invalidateQueries({ queryKey: documentShareTargetsKey(docId) });
    },
  });
}
