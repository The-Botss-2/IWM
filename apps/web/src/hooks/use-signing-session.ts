'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DeclinePublicInput,
  PublicSignatureSession,
  SignatureFieldKind,
  SignPublicInput,
} from '@botss/shared-types';

import { useInvalidatePortalClient } from '@/hooks/use-portal-signatures';
import { getApi } from '@/lib/api';
import { saveFile } from '@/lib/save-file';
import { sessionQueryKey } from '@/lib/session-query';
import { boxAt, clampBox, fieldKey, type DraftField, type FieldBox } from '@/lib/signatures/fields';
import { describeError, toastError } from '@/lib/toast';
import type { AdoptedSignature } from '@/components/signatures/signature-pad-dialog';

/**
 * How the signer arrived. `token`: the emailed link (no account); the token
 * in the URL plus the 6-digit code from the same email, typed on the page,
 * are the credential. `portal`: a signed-in client person opening their own
 * signer row. Both reach one server implementation.
 */
export type SigningSource =
  | { kind: 'token'; token: string }
  | { kind: 'portal'; clientId: string; signerId: string };

type LoadState =
  | { kind: 'loading' }
  /** Emailed link only: waiting for the code (again, after a wrong one). */
  | { kind: 'code'; error: string | null }
  | { kind: 'gone'; title: string; message: string }
  | { kind: 'ready'; session: PublicSignatureSession };

type PdfFile = { blob: Blob; filename: string | null };

/** The SDK calls behind one source. Everything else in the hook is shared. */
interface SigningCalls {
  session: () => Promise<PublicSignatureSession>;
  sourceFile: () => Promise<PdfFile>;
  signedFile: () => Promise<PdfFile>;
  sign: (input: SignPublicInput) => Promise<unknown>;
  decline: (input: DeclinePublicInput) => Promise<unknown>;
}

function signingCalls(source: SigningSource, code: () => string): SigningCalls {
  if (source.kind === 'token') {
    const api = getApi().signatures;
    const { token } = source;
    return {
      session: () => api.publicSession(token, code()),
      sourceFile: () => api.publicSourceFile(token, code()),
      signedFile: () => api.publicSignedFile(token, code()),
      sign: (input) => api.publicSign(token, code(), input),
      decline: (input) => api.publicDecline(token, code(), input),
    };
  }
  const api = getApi().portal;
  const { clientId, signerId } = source;
  return {
    session: () => api.signatureSession(clientId, signerId),
    sourceFile: () => api.signatureSourceFile(clientId, signerId),
    signedFile: () => api.signatureSignedFile(clientId, signerId),
    sign: (input) => api.sign(clientId, signerId, input),
    decline: (input) => api.decline(clientId, signerId, input),
  };
}

/** The source's identity. Callers pass a fresh object every render. */
function sourceKey(source: SigningSource): string {
  return source.kind === 'token' ? source.token : `portal:${source.clientId}:${source.signerId}`;
}

/** What to say when the session cannot be opened (404, 410, anything else). */
function goneCopy(kind: SigningSource['kind'], err: unknown): { title: string; message: string } {
  const status = (err as { status?: number })?.status;
  if (kind === 'portal') {
    // Signed in, so nothing here is about a link. The API's 404 text is
    // written for emailed links, so it is not shown.
    if (status === 404) {
      return {
        title: 'This request is not available',
        message: 'It may have been cancelled, or it is not addressed to you.',
      };
    }
    return {
      title: status === 410 ? 'This request has expired' : 'Something went wrong',
      message: describeError(
        err,
        status === 410 ? 'Ask the sender to send it again.' : 'Please try again in a moment.',
      ),
    };
  }
  if (status === 423) {
    return {
      title: 'This link is locked',
      message: describeError(
        err,
        'Too many wrong codes were entered. Ask the sender to send it again.',
      ),
    };
  }
  return {
    title:
      status === 410
        ? 'This signing link has expired'
        : status === 404
          ? 'This link is not valid'
          : 'Something went wrong',
    message: describeError(
      err,
      status === 404
        ? 'It may have been replaced by a newer email, or the request was cancelled.'
        : 'Please try again in a moment.',
    ),
  };
}

/**
 * All state for signing one request: the session, the adopted signature,
 * signer-placed fields (only when the requester placed none), and the sign /
 * decline calls. Shared by the emailed link and the client portal; the
 * `source` only picks the SDK calls and the error copy. The view only renders.
 */
export function useSigningSession(source: SigningSource) {
  const sourceKind = source.kind;
  const key = sourceKey(source);
  // The code typed on the emailed-link page. Held in memory only (never in
  // storage or the URL); a reload asks for it again.
  const codeRef = useRef('');
  const calls = useMemo(
    () => signingCalls(source, () => codeRef.current),
    // `key` is the source's identity; the object itself is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  const invalidatePortalClient = useInvalidatePortalClient();
  const queryClient = useQueryClient();
  // Portal only: these calls go straight to the SDK, not through TanStack
  // Query, so the portal gate's access watch never sees their 401s. A lost
  // session re-checks /auth/me, and the gate then sends the person to
  // sign-in instead of leaving them on a dead page. The emailed link has no
  // session, so nothing to do there.
  const recheckSession = useCallback(
    (err: unknown) => {
      if (sourceKind === 'portal' && (err as { status?: number } | null)?.status === 401) {
        void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      }
    },
    [sourceKind, queryClient],
  );
  const [state, setState] = useState<LoadState>(
    sourceKind === 'token' ? { kind: 'code', error: null } : { kind: 'loading' },
  );
  const [adopted, setAdopted] = useState<AdoptedSignature | null>(null);
  const [placed, setPlaced] = useState<DraftField[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | 'signed' | 'declined'>(null);

  const load = useCallback(async () => {
    try {
      const session = await calls.session();
      setState({ kind: 'ready', session });
    } catch (err) {
      recheckSession(err);
      // Emailed link: a missing or wrong code goes back to the code form
      // with the server's message (it says how many tries are left).
      if (sourceKind === 'token' && (err as { status?: number } | null)?.status === 401) {
        setState({ kind: 'code', error: describeError(err, 'That code is not right.') });
        return;
      }
      setState({ kind: 'gone', ...goneCopy(sourceKind, err) });
    }
  }, [calls, sourceKind, recheckSession]);

  useEffect(() => {
    // The emailed link waits for the code before it asks for anything.
    if (sourceKind !== 'token') void load();
  }, [load, sourceKind]);

  /** Emailed link: try a code typed by the signer. */
  const submitCode = useCallback(
    (code: string) => {
      codeRef.current = code.trim();
      setState({ kind: 'loading' });
      void load();
    },
    [load],
  );

  const session = state.kind === 'ready' ? state.session : null;
  const canPlace = Boolean(session?.canPlaceFields);

  /**
   * The fields this signer fills: the requester's, plus the signer's own when
   * the requester gave them no signature box. Only the signer's own boxes
   * can be moved or removed.
   */
  const fields: Array<{ key: string; kind: SignatureFieldKind; box: FieldBox; mine: boolean }> =
    useMemo(() => {
      if (!session) return [];
      const given = session.fields.map((f) => ({
        key: f.id,
        kind: f.kind,
        box: { page: f.page, x: f.x, y: f.y, w: f.w, h: f.h },
        mine: false,
      }));
      if (!canPlace) return given;
      return [
        ...given,
        ...placed.map((f) => ({ key: f.key, kind: f.kind, box: f as FieldBox, mine: true })),
      ];
    }, [session, canPlace, placed]);

  const placeAt = (page: number, point: { x: number; y: number }, kind: SignatureFieldKind) => {
    if (!canPlace) return;
    setPlaced((prev) => [
      ...prev,
      { key: fieldKey(), kind, signerId: 'me', ...boxAt(kind, page, point.x, point.y) },
    ]);
  };
  const updatePlaced = (key: string, box: FieldBox) =>
    setPlaced((prev) => prev.map((f) => (f.key === key ? { ...f, ...clampBox(box) } : f)));
  const removePlaced = (key: string) => setPlaced((prev) => prev.filter((f) => f.key !== key));

  const hasSignatureField = fields.some((f) => f.kind === 'SIGNATURE');
  const ready = Boolean(adopted) && hasSignatureField && !submitting;

  /** Portal only: the signatures list and the overview count are now stale. */
  const answered = () => {
    if (source.kind === 'portal') void invalidatePortalClient(source.clientId);
  };

  const submit = async (signerName?: string) => {
    if (!adopted || !session) return;
    setSubmitting(true);
    try {
      await calls.sign({
        consent: true,
        method: adopted.method,
        imageDataUrl: adopted.imageDataUrl,
        ...(adopted.typedName ? { typedName: adopted.typedName } : {}),
        ...(signerName?.trim() ? { signerName: signerName.trim() } : {}),
        ...(canPlace
          ? {
              fields: placed.map((f) => ({
                kind: f.kind,
                page: f.page,
                x: f.x,
                y: f.y,
                w: f.w,
                h: f.h,
              })),
            }
          : {}),
      });
      setDone('signed');
      answered();
      await load();
    } catch (err) {
      recheckSession(err);
      toastError(err, "Couldn't submit your signature");
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async (reason: string) => {
    setSubmitting(true);
    try {
      await calls.decline({ reason });
      setDone('declined');
      answered();
      if (sourceKind === 'token') {
        // The server retires an emailed link once its signer declines, so a
        // reload would 404. Show the outcome from what we already know.
        setState((prev) =>
          prev.kind === 'ready'
            ? {
                kind: 'ready',
                session: {
                  ...prev.session,
                  requestStatus: 'DECLINED',
                  signer: { ...prev.session.signer, status: 'DECLINED' },
                },
              }
            : prev,
        );
      } else {
        await load();
      }
    } catch (err) {
      recheckSession(err);
      toastError(err, "Couldn't decline");
    } finally {
      setSubmitting(false);
    }
  };

  const downloadSigned = async () => {
    try {
      const { blob, filename } = await calls.signedFile();
      await saveFile(blob, filename ?? `${session?.title ?? 'document'} (signed).pdf`);
    } catch (err) {
      recheckSession(err);
      toastError(err, "Couldn't download the signed PDF");
    }
  };

  return {
    state,
    submitCode,
    session,
    fields,
    canPlace,
    placeAt,
    updatePlaced,
    removePlaced,
    adopted,
    setAdopted,
    ready,
    submitting,
    submit,
    decline,
    done,
    downloadSigned,
    /** Identifies the PDF for `usePdfDocument`: one per source. */
    fileKey: key,
    loadPdf: calls.sourceFile,
  };
}
