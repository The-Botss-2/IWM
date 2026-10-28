'use client';

import { Check, Copy, Download, FileSignature, RotateCw, Send, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/** Requests shown before "Show more": keeps the editor on screen. */
const VISIBLE_BY_DEFAULT = 2;
import type { SignatureRequestSummary, SignerStatus } from '@botss/shared-types';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  useCancelSignatureRequest,
  useDownloadSignedPdf,
  useResendSigner,
  useRetrySeal,
  useSignatureRequests,
} from '@/hooks/use-signatures';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

const REQUEST_TONE = {
  DRAFT: 'neutral',
  SENT: 'info',
  COMPLETED: 'success',
  DECLINED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'warning',
} as const;

const REQUEST_LABEL = {
  DRAFT: 'Draft',
  SENT: 'Waiting for signatures',
  COMPLETED: 'Signed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
} as const;

const SIGNER_LABEL: Record<SignerStatus, string> = {
  PENDING: 'Not opened',
  VIEWED: 'Viewed',
  SIGNED: 'Signed',
  DECLINED: 'Declined',
};

function when(d: Date | null): string {
  if (!d) return '';
  return new Date(d).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Signature requests on a document: status, per-signer progress, and the
 * actions that fit the state (resend, cancel, download, retry sealing).
 * Drafts are hidden; they only exist while the request dialog is open.
 */
export function SignatureStatusCard({
  documentId,
  currentUserId,
  isWorkspaceAdmin,
}: {
  documentId: string;
  currentUserId: string | null;
  isWorkspaceAdmin: boolean;
}) {
  const list = useSignatureRequests(documentId);
  const [showAll, setShowAll] = useState(false);
  const items = (list.data?.items ?? []).filter((r) => r.status !== 'DRAFT');
  if (items.length === 0) return null;
  const hidden = items.length - VISIBLE_BY_DEFAULT;
  const shown = showAll ? items : items.slice(0, VISIBLE_BY_DEFAULT);
  return (
    <section aria-label="Signature requests" className="space-y-2">
      {shown.map((r) => (
        <SignatureRequestRow
          key={r.id}
          request={r}
          canManage={isWorkspaceAdmin || r.createdById === currentUserId}
        />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="text-ink-muted hover:text-ink focus-visible:shadow-focus text-xs font-medium focus-visible:outline-none"
        >
          {showAll
            ? 'Show fewer requests'
            : `Show ${hidden} older request${hidden === 1 ? '' : 's'}`}
        </button>
      ) : null}
    </section>
  );
}

/**
 * One signature request: status, per-signer progress and the actions that fit
 * its state. `subtitle` adds a line under the title (the client page uses it
 * for the source document and the sent and completed dates).
 */
export function SignatureRequestRow({
  request: r,
  canManage,
  subtitle,
}: {
  request: SignatureRequestSummary;
  canManage: boolean;
  subtitle?: ReactNode;
}) {
  const resend = useResendSigner();
  const cancel = useCancelSignatureRequest();
  const download = useDownloadSignedPdf();
  const retry = useRetrySeal();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [link, setLink] = useState<{ signerId: string; url: string; code?: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const signed = r.signers.filter((s) => s.status === 'SIGNED').length;
  const allSigned = signed === r.signers.length;
  const sealing = r.status === 'SENT' && allSigned;

  return (
    <div className="border-line bg-bg-surface rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FileSignature className="text-brand-purple h-4 w-4" aria-hidden />
        <span className="text-ink min-w-0 flex-1 truncate text-sm font-medium">{r.title}</span>
        <Badge tone={sealing ? 'info' : REQUEST_TONE[r.status]}>
          {sealing ? 'Preparing signed PDF' : REQUEST_LABEL[r.status]}
        </Badge>
        <span className="text-ink-muted text-xs">
          {signed}/{r.signers.length} signed
        </span>
      </div>
      {subtitle ? <div className="text-ink-muted mt-1 text-xs">{subtitle}</div> : null}

      <ul className="divide-line mt-2 divide-y">
        {r.signers.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
            <span
              aria-hidden
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                s.status === 'SIGNED'
                  ? 'bg-state-success'
                  : s.status === 'DECLINED'
                    ? 'bg-state-error'
                    : s.status === 'VIEWED'
                      ? 'bg-state-warning'
                      : 'bg-state-pending',
              )}
            />
            <span className="min-w-0 flex-1 truncate">
              {s.name ? `${s.name} ` : ''}
              <span className="text-ink-muted">{s.email}</span>
            </span>
            <span className="text-ink-muted text-xs">
              {SIGNER_LABEL[s.status]}
              {s.status === 'SIGNED'
                ? ` ${when(s.signedAt)}`
                : s.status === 'VIEWED'
                  ? ` ${when(s.viewedAt)}`
                  : ''}
            </span>
            {canManage &&
            r.status === 'SENT' &&
            (s.status === 'PENDING' || s.status === 'VIEWED') ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={resend.isPending}
                onClick={() =>
                  resend.mutate(
                    { id: r.id, signerId: s.id },
                    {
                      onSuccess: (res) => {
                        const l = res.links[0];
                        if (l) setLink({ signerId: l.signerId, url: l.url, code: l.code });
                      },
                    },
                  )
                }
              >
                <Send className="mr-1 h-3.5 w-3.5" aria-hidden />
                Resend
              </Button>
            ) : null}
            {s.status === 'DECLINED' && s.declineReason ? (
              <p className="text-state-error w-full pl-4 text-xs">
                &ldquo;{s.declineReason}&rdquo;
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {link ? (
        <div className="bg-bg-subtle mt-2 flex items-center gap-2 rounded-md p-2 text-xs">
          <span className="text-ink-muted min-w-0 flex-1 truncate">New link: {link.url}</span>
          {link.code ? <span className="text-ink-muted font-mono">Code {link.code}</span> : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const text = link.code ? `${link.url}\nCode: ${link.code}` : link.url;
              void navigator.clipboard.writeText(text).then(
                () => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                },
                (err: unknown) =>
                  toastError(err, "Couldn't copy the link. Select it and copy it by hand."),
              );
            }}
          >
            {copied ? (
              <Check className="mr-1 h-3.5 w-3.5" />
            ) : (
              <Copy className="mr-1 h-3.5 w-3.5" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {r.status === 'COMPLETED' && r.hasSignedFile ? (
          <Button
            size="sm"
            onClick={() => download.mutate({ id: r.id, title: r.title })}
            disabled={download.isPending}
          >
            <Download className="mr-1 h-3.5 w-3.5" aria-hidden />
            {download.isPending ? 'Downloading...' : 'Download signed PDF'}
          </Button>
        ) : null}
        {canManage && sealing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => retry.mutate(r.id)}
            disabled={retry.isPending}
          >
            <RotateCw className="mr-1 h-3.5 w-3.5" aria-hidden />
            Retry signed PDF
          </Button>
        ) : null}
        {canManage && r.status === 'SENT' && !allSigned ? (
          <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)}>
            <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden />
            Cancel request
          </Button>
        ) : null}
        {r.status === 'COMPLETED' && r.signedSha256 ? (
          <span
            className="text-ink-muted ml-auto truncate font-mono text-[10px]"
            title={r.signedSha256}
          >
            SHA-256 {r.signedSha256.slice(0, 16)}...
          </span>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this signature request?"
        description="Every signing link stops working. Signatures already given are kept in the audit trail."
        confirmLabel="Cancel request"
        cancelLabel="Keep it"
        variant="destructive"
        pending={cancel.isPending}
        onConfirm={() => cancel.mutateAsync(r.id).then(() => setConfirmCancel(false))}
      />
    </div>
  );
}
