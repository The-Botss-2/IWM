'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import type {
  CreateSignatureRequestInput,
  SessionContext,
  SendSignatureRequestInput,
  SetSignatureFieldsInput,
  SignatureRequestDetails,
} from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { useCurrentWorkspace } from '@/hooks/use-workspace';
import { useAbility } from '@/lib/ability';
import { getApi } from '@/lib/api';
import { saveFile } from '@/lib/save-file';
import { openPdf, type PdfDocument } from '@/lib/signatures/pdf';
import { describeError, toast } from '@/lib/toast';

const signaturesKey = (documentId?: string) => ['signatures', 'list', documentId ?? 'all'] as const;
const signatureKey = (id: string) => ['signatures', 'one', id] as const;

/** Requests attached to a document, newest first. */
export function useSignatureRequests(documentId: string | null) {
  // Workspace VIEWER and CLIENT roles cannot read signature requests; skip
  // the call instead of taking a 403 (and its retries) on every document.
  const canRead = useAbility().can('read', 'SignatureRequest');
  return useQuery({
    queryKey: signaturesKey(documentId ?? undefined),
    queryFn: () => getApi().signatures.list({ documentId: documentId! }),
    enabled: Boolean(documentId) && canRead,
    retry: 1,
    // Signers act outside the app; poll gently while something is open.
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'SENT') ? 30_000 : false),
  });
}

function useInvalidateSignatures() {
  const qc = useQueryClient();
  return (details?: SignatureRequestDetails) => {
    if (details) qc.setQueryData(signatureKey(details.id), details);
    void qc.invalidateQueries({ queryKey: ['signatures', 'list'] });
  };
}

export function useCreateSignatureRequest() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    meta: { errorTitle: "Couldn't create signature request" },
    mutationFn: (input: CreateSignatureRequestInput) => getApi().signatures.create(input),
    onSuccess: (d) => invalidate(d),
  });
}

export function useSetSignatureFields() {
  return useMutation({
    meta: { errorTitle: "Couldn't save signature fields" },
    mutationFn: (args: { id: string; input: SetSignatureFieldsInput }) =>
      getApi().signatures.setFields(args.id, args.input),
  });
}

export function useSendSignatureRequest() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    meta: { errorTitle: "Couldn't send signature request" },
    mutationFn: (args: { id: string; input: Partial<SendSignatureRequestInput> }) =>
      getApi().signatures.send(args.id, args.input),
    onSuccess: (res) => invalidate(res.request),
  });
}

export function useDiscardSignatureDraft() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    // Cleanup of an unsent draft when the dialog closes or steps back. The
    // flow moves on either way, but a failure leaves the draft behind - say so.
    meta: { errorTitle: "Couldn't discard the signature draft" },
    mutationFn: (id: string) => getApi().signatures.removeDraft(id),
    onSuccess: () => invalidate(),
  });
}

export function useResendSigner() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    meta: { errorTitle: "Couldn't resend signing link" },
    mutationFn: (args: { id: string; signerId: string }) =>
      getApi().signatures.resend(args.id, args.signerId),
    onSuccess: (res) => invalidate(res.request),
  });
}

export function useCancelSignatureRequest() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    meta: { errorTitle: "Couldn't cancel signature request" },
    mutationFn: (id: string) => getApi().signatures.cancel(id),
    onSuccess: (d) => {
      invalidate(d);
      toast.success('Request cancelled. The signing links no longer work.');
    },
  });
}

export function useRetrySeal() {
  const invalidate = useInvalidateSignatures();
  return useMutation({
    meta: { errorTitle: "Couldn't retry sealing" },
    mutationFn: (id: string) => getApi().signatures.retrySeal(id),
    onSuccess: (d) => {
      invalidate(d);
      toast.success('Preparing the signed PDF again.');
    },
  });
}

/** Download the sealed PDF through the credentialed client (works in the
 *  desktop and mobile shells, see lib/save-file). */
export function useDownloadSignedPdf() {
  return useMutation({
    meta: { errorTitle: "Couldn't download signed PDF" },
    mutationFn: async (args: { id: string; title: string }) => {
      const { blob, filename } = await getApi().signatures.signedFile(args.id);
      await saveFile(blob, filename ?? `${args.title} (signed).pdf`);
    },
  });
}

/**
 * Load a PDF (fetched as a Blob) into pdf.js. `key` identifies the file; the
 * document is re-opened when it changes and destroyed on unmount.
 */
export function usePdfDocument(key: string | null, load: () => Promise<{ blob: Blob }>) {
  const [state, setState] = useState<
    | { status: 'idle' | 'loading' }
    | { status: 'ready'; doc: PdfDocument; bytes: ArrayBuffer }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  useEffect(() => {
    if (!key) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    let opened: PdfDocument | null = null;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const { blob } = await load();
        const bytes = await blob.arrayBuffer();
        const doc = await openPdf(bytes);
        if (cancelled) {
          void doc.destroy();
          return;
        }
        opened = doc;
        setState({ status: 'ready', doc, bytes });
      } catch (err) {
        if (!cancelled)
          setState({ status: 'error', message: describeError(err, "Couldn't open the PDF.") });
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void opened.destroy();
    };
    // `load` is recreated every render; `key` is the identity that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/**
 * Who is looking, for the UX hints on signature requests. Mirrors the API:
 * the request's creator or a workspace OWNER/ADMIN may resend and cancel.
 */
export function useSignatureViewer(): { userId: string | null; isWorkspaceAdmin: boolean } {
  const session = useSessionContext();
  const workspace = useCurrentWorkspace();
  return useMemo(() => {
    const data = session.data as SessionContext | undefined;
    const membership = data?.workspaceMemberships.find((m) => m.workspaceId === workspace.data?.id);
    return {
      userId: data?.user?.id ?? null,
      isWorkspaceAdmin: membership?.role === 'OWNER' || membership?.role === 'ADMIN',
    };
  }, [session.data, workspace.data?.id]);
}
