'use client';

import { useState } from 'react';
import {
  createSignatureRequestSchema,
  type CreateSignatureRequestInput,
  type SignatureFieldKind,
  type SignatureRequestDetails,
  type SigningLinksResponse,
} from '@botss/shared-types';

import { useFileUpload } from '@/hooks/use-file-upload';
import {
  useCreateSignatureRequest,
  useDiscardSignatureDraft,
  useSendSignatureRequest,
  useSetSignatureFields,
} from '@/hooks/use-signatures';
import { getApi } from '@/lib/api';
import { boxAt, clampBox, fieldKey, type DraftField, type FieldBox } from '@/lib/signatures/fields';
import { describeError, markErrorReported, toast } from '@/lib/toast';

export type FlowStep = 'signers' | 'fields' | 'send' | 'sent';

export interface SignerRow {
  key: string;
  email: string;
  name: string;
}

/**
 * State machine behind "Request signatures":
 *
 *   signers -> (create DRAFT, PDF frozen) -> fields -> (save fields) -> send -> sent
 *
 * The DRAFT exists from step 2 so the requester places fields on the exact
 * PDF signers will see. Closing the dialog before sending discards it.
 */
export function useRequestSignaturesFlow(documentId: string, documentTitle: string) {
  const [step, setStep] = useState<FlowStep>('signers');
  const [signers, setSigners] = useState<SignerRow[]>([{ key: fieldKey(), email: '', name: '' }]);
  const [title, setTitle] = useState(documentTitle);
  const [source, setSource] = useState<'document' | 'upload'>('document');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<SignatureRequestDetails | null>(null);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [activeSigner, setActiveSigner] = useState(0);
  const [kind, setKind] = useState<SignatureFieldKind>('SIGNATURE');
  const [message, setMessage] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [result, setResult] = useState<SigningLinksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = useFileUpload();
  const create = useCreateSignatureRequest();
  const saveFields = useSetSignatureFields();
  const send = useSendSignatureRequest();
  const discard = useDiscardSignatureDraft();

  const busy = upload.isPending || create.isPending || saveFields.isPending || send.isPending;

  // --- step 1 --------------------------------------------------------------

  const addSigner = () =>
    setSigners((rows) =>
      rows.length >= 20 ? rows : [...rows, { key: fieldKey(), email: '', name: '' }],
    );
  const removeSigner = (key: string) =>
    setSigners((rows) => (rows.length <= 1 ? rows : rows.filter((r) => r.key !== key)));
  const updateSigner = (key: string, patch: Partial<SignerRow>) =>
    setSigners((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  /** The create payload minus the uploaded file, which exists only after upload. */
  const basePayload = (): CreateSignatureRequestInput => ({
    documentId,
    ...(title.trim() ? { title: title.trim() } : {}),
    signers: signers.map((s) => ({
      email: s.email.trim().toLowerCase(),
      ...(s.name.trim() ? { name: s.name.trim() } : {}),
    })),
  });

  /** Same Zod rules as the API, checked before the slow upload and render. */
  const signersError = (): string | null => {
    const parsed = createSignatureRequestSchema.safeParse(basePayload());
    if (!parsed.success) return parsed.error.issues[0]?.message ?? 'Check the signers.';
    if (source === 'upload' && !pdfFile) return 'Choose a PDF to upload.';
    if (
      source === 'upload' &&
      pdfFile &&
      pdfFile.type !== 'application/pdf' &&
      !/\.pdf$/i.test(pdfFile.name)
    ) {
      return 'Only PDF files can be signed.';
    }
    return null;
  };

  const toFields = async () => {
    setError(null);
    const problem = signersError();
    if (problem) {
      setError(problem);
      return;
    }
    try {
      let sourceFileId: string | undefined;
      if (source === 'upload' && pdfFile) {
        const pdfAsFile =
          pdfFile.type === 'application/pdf'
            ? pdfFile
            : new File([pdfFile], pdfFile.name, { type: 'application/pdf' });
        sourceFileId = (await upload.mutateAsync(pdfAsFile)).id;
      }
      const created = await create.mutateAsync({
        ...basePayload(),
        ...(sourceFileId ? { sourceFileId } : {}),
      });
      setDraft(created);
      setFields([]);
      setActiveSigner(0);
      setStep('fields');
    } catch (err) {
      markErrorReported(); // shown inline in the dialog
      setError(describeError(err, "Couldn't prepare the document for signing."));
    }
  };

  // --- step 2 --------------------------------------------------------------

  const placeAt = (page: number, point: { x: number; y: number }) => {
    const signer = draft?.signers[activeSigner];
    if (!signer) return;
    setFields((prev) => [
      ...prev,
      { key: fieldKey(), kind, signerId: signer.id, ...boxAt(kind, page, point.x, point.y) },
    ]);
  };
  const updateField = (key: string, box: FieldBox) =>
    setFields((prev) => prev.map((f) => (f.key === key ? { ...f, ...clampBox(box) } : f)));
  const removeField = (key: string) => setFields((prev) => prev.filter((f) => f.key !== key));

  /** Signers with no signature box place their own when they sign. */
  const signersWithoutField = (draft?.signers ?? []).filter(
    (s) => !fields.some((f) => f.signerId === s.id && f.kind === 'SIGNATURE'),
  );

  const toSend = async () => {
    if (!draft) return;
    setError(null);
    try {
      await saveFields.mutateAsync({
        id: draft.id,
        input: {
          fields: fields.map((f) => ({
            signerId: f.signerId,
            kind: f.kind,
            page: f.page,
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
          })),
        },
      });
      setStep('send');
    } catch (err) {
      markErrorReported(); // shown inline in the dialog
      setError(describeError(err, "Couldn't save the fields."));
    }
  };

  const backToSigners = async () => {
    // A failed discard is toasted by useDiscardSignatureDraft's meta.errorTitle.
    if (draft) await discard.mutateAsync(draft.id).catch(() => undefined);
    setDraft(null);
    setFields([]);
    setStep('signers');
  };

  // --- step 3 --------------------------------------------------------------

  const sendNow = async () => {
    if (!draft) return;
    setError(null);
    try {
      const res = await send.mutateAsync({
        id: draft.id,
        input: {
          expiresInDays,
          message: message.trim() || null,
          ...(title.trim() ? { title: title.trim() } : {}),
        },
      });
      setResult(res);
      setDraft(null);
      setStep('sent');
      toast.success(
        res.emailed
          ? 'Signature request created and queued for email delivery.'
          : 'Signature request created. Copy and share the signing links below.',
      );
    } catch (err) {
      markErrorReported(); // shown inline in the dialog
      setError(describeError(err, "Couldn't send the request."));
    }
  };

  /** Call when the dialog closes: an unsent DRAFT is thrown away. */
  const abandon = () => {
    // A failed discard is toasted by useDiscardSignatureDraft's meta.errorTitle.
    if (draft) void discard.mutateAsync(draft.id).catch(() => undefined);
  };

  return {
    step,
    setStep,
    signers,
    addSigner,
    removeSigner,
    updateSigner,
    title,
    setTitle,
    source,
    setSource,
    pdfFile,
    setPdfFile,
    draft,
    fields,
    activeSigner,
    setActiveSigner,
    kind,
    setKind,
    placeAt,
    updateField,
    removeField,
    signersWithoutField,
    message,
    setMessage,
    expiresInDays,
    setExpiresInDays,
    result,
    error,
    busy,
    preparing: upload.isPending || create.isPending,
    toFields,
    toSend,
    backToSigners,
    sendNow,
    abandon,
    loadDraftPdf: () => getApi().signatures.sourceFile(draft!.id),
  };
}
