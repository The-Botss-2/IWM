'use client';

import { CalendarDays, Check, Copy, FileText, PenLine, Plus, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';

import { FieldBox } from '@/components/signatures/field-box';
import { PdfPages } from '@/components/signatures/pdf-pages';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader, PageLoader } from '@/components/ui/loader';
import { Textarea } from '@/components/ui/textarea';
import { useRequestSignaturesFlow } from '@/hooks/use-request-signatures-flow';
import { usePdfDocument } from '@/hooks/use-signatures';
import { signerColor } from '@/lib/signatures/fields';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/utils';

const STEPS = [
  { key: 'signers', label: 'Signers' },
  { key: 'fields', label: 'Place fields' },
  { key: 'send', label: 'Send' },
] as const;

const EXPIRY_OPTIONS = [3, 7, 14, 30, 60];

/**
 * "Request signatures" for a document. Mounted only while open, so every open
 * starts a fresh flow.
 */
export function RequestSignaturesDialog({
  documentId,
  documentTitle,
  open,
  onOpenChange,
}: {
  documentId: string;
  documentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) return null;
  return (
    <RequestSignaturesFlow documentId={documentId} documentTitle={documentTitle} onOpenChange={onOpenChange} />
  );
}

function RequestSignaturesFlow({
  documentId,
  documentTitle,
  onOpenChange,
}: {
  documentId: string;
  documentTitle: string;
  onOpenChange: (open: boolean) => void;
}) {
  const f = useRequestSignaturesFlow(documentId, documentTitle);
  const pdf = usePdfDocument(f.draft?.id ?? null, f.loadDraftPdf);

  const close = () => {
    f.abandon();
    onOpenChange(false);
  };

  const stepIndex = STEPS.findIndex((s) => s.key === f.step);

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : close())}>
      <DialogContent
        className={cn('gap-5 p-6', f.step === 'fields' ? 'sm:max-w-5xl' : 'sm:max-w-xl')}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold">
            {f.step === 'sent' ? 'Signature request sent' : 'Request signatures'}
          </DialogTitle>
          <DialogDescription className="text-sm text-ink-muted">
            {f.step === 'sent'
              ? 'Each signer gets their own link. No account is needed to sign.'
              : 'Signers get an email link and sign in the browser without an account.'}
          </DialogDescription>
        </DialogHeader>

        {f.step !== 'sent' ? (
          <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2">
                <span
                  className={cn(
                    'grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold',
                    i < stepIndex
                      ? 'bg-brand-gradient text-white'
                      : i === stepIndex
                        ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-purple'
                        : 'bg-bg-subtle text-ink-muted',
                  )}
                  aria-current={i === stepIndex ? 'step' : undefined}
                >
                  {i < stepIndex ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <span className={i === stepIndex ? 'font-semibold text-ink' : 'text-ink-muted'}>{s.label}</span>
                {i < STEPS.length - 1 ? <span className="h-px w-6 bg-line" aria-hidden /> : null}
              </li>
            ))}
          </ol>
        ) : null}

        {f.step === 'signers' ? <SignersStep f={f} /> : null}
        {f.step === 'fields' ? <FieldsStep f={f} pdf={pdf} /> : null}
        {f.step === 'send' ? <SendStep f={f} /> : null}
        {f.step === 'sent' && f.result ? <SentStep result={f.result} /> : null}

        {f.error ? (
          <p role="alert" className="rounded-md bg-tint-error px-3 py-2 text-sm text-state-error">
            {f.error}
          </p>
        ) : null}

        <DialogFooter>
          {f.step === 'signers' ? (
            <>
              <Button variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button onClick={() => void f.toFields()} disabled={f.busy}>
                {f.preparing ? 'Preparing PDF...' : 'Next: place fields'}
              </Button>
            </>
          ) : f.step === 'fields' ? (
            <>
              <Button variant="secondary" onClick={() => void f.backToSigners()} disabled={f.busy}>
                Back
              </Button>
              <Button onClick={() => void f.toSend()} disabled={f.busy}>
                Next: review and send
              </Button>
            </>
          ) : f.step === 'send' ? (
            <>
              <Button variant="secondary" onClick={() => f.setStep('fields')} disabled={f.busy}>
                Back
              </Button>
              <Button onClick={() => void f.sendNow()} disabled={f.busy}>
                {f.busy ? 'Sending...' : 'Send for signature'}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Flow = ReturnType<typeof useRequestSignaturesFlow>;

function SignersStep({ f }: { f: Flow }) {
  return (
    <div className="space-y-5">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">What should they sign?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { key: 'document', icon: FileText, title: 'This document', hint: 'Turned into a PDF as it is now' },
              { key: 'upload', icon: Upload, title: 'Upload a PDF', hint: 'For contracts made elsewhere' },
            ] as const
          ).map((o) => (
            <label
              key={o.key}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-colors',
                f.source === o.key ? 'border-brand-purple bg-brand-50' : 'border-line hover:bg-bg-subtle',
              )}
            >
              <input
                type="radio"
                name="signature-source"
                className="mt-1 accent-brand-purple"
                checked={f.source === o.key}
                onChange={() => f.setSource(o.key)}
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <o.icon className="h-4 w-4" aria-hidden />
                  {o.title}
                </span>
                <span className="block text-xs text-ink-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {f.source === 'upload' ? (
          <Input
            type="file"
            accept="application/pdf,.pdf"
            aria-label="PDF to sign"
            onChange={(e) => f.setPdfFile(e.target.files?.[0] ?? null)}
          />
        ) : null}
        {f.source === 'upload' && f.pdfFile ? (
          <p className="truncate text-xs text-ink-muted">Selected: {f.pdfFile.name}</p>
        ) : null}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="signature-title">Title</Label>
        <Input id="signature-title" value={f.title} maxLength={200} onChange={(e) => f.setTitle(e.target.value)} />
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-ink">Signers</legend>
        {f.signers.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: signerColor(i) }}
            />
            <Input
              type="email"
              placeholder="Email"
              aria-label={`Signer ${i + 1} email`}
              value={s.email}
              onChange={(e) => f.updateSigner(s.key, { email: e.target.value })}
              className="min-w-0 flex-[3]"
              autoComplete="off"
            />
            <Input
              placeholder="Name (optional)"
              aria-label={`Signer ${i + 1} name`}
              value={s.name}
              onChange={(e) => f.updateSigner(s.key, { name: e.target.value })}
              className="min-w-0 flex-[2]"
            />
            <button
              type="button"
              onClick={() => f.removeSigner(s.key)}
              disabled={f.signers.length <= 1}
              aria-label={`Remove signer ${i + 1}`}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-tint-error hover:text-state-error disabled:opacity-30"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <Button variant="ghost" size="sm" onClick={f.addSigner} disabled={f.signers.length >= 20}>
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          Add signer
        </Button>
      </fieldset>
    </div>
  );
}

function FieldsStep({ f, pdf }: { f: Flow; pdf: ReturnType<typeof usePdfDocument> }) {
  const signers = f.draft?.signers ?? [];
  return (
    <div className="grid gap-4 md:grid-cols-[220px_1fr]">
      <aside className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Placing for</p>
          <div className="space-y-1" role="radiogroup" aria-label="Signer">
            {signers.map((s, i) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={f.activeSigner === i}
                onClick={() => f.setActiveSigner(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm',
                  f.activeSigner === i ? 'border-2' : 'border-line hover:bg-bg-subtle',
                )}
                style={f.activeSigner === i ? { borderColor: signerColor(i) } : undefined}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: signerColor(i) }} />
                <span className="truncate">{s.name || s.email}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Field</p>
          <div className="flex gap-1.5" role="radiogroup" aria-label="Field type">
            {(['SIGNATURE', 'DATE'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={f.kind === k}
                onClick={() => f.setKind(k)}
                className={cn(
                  'inline-flex flex-1 items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium',
                  f.kind === k ? 'border-brand-purple bg-brand-50 text-brand-700' : 'border-line text-ink-muted',
                )}
              >
                {k === 'SIGNATURE' ? <PenLine className="h-3.5 w-3.5" /> : <CalendarDays className="h-3.5 w-3.5" />}
                {k === 'SIGNATURE' ? 'Signature' : 'Date'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-ink-muted">
          Click the page to add a field for the selected signer. Drag to move, pull the corner to resize.
        </p>
        {f.signersWithoutField.length > 0 ? (
          <p className="rounded-md bg-tint-warning px-2.5 py-2 text-xs text-brand-orange">
            {f.signersWithoutField.map((s) => s.name || s.email).join(', ')}{' '}
            {f.signersWithoutField.length === 1 ? 'has' : 'have'} no signature box and will place their own.
          </p>
        ) : null}
      </aside>

      <div className="max-h-[65vh] overflow-y-auto rounded-lg bg-bg-subtle p-3">
        {pdf.status === 'ready' ? (
          <PdfPages
            doc={pdf.doc}
            onPageClick={(page, point) => f.placeAt(page, point)}
            overlay={(page) =>
              f.fields
                .filter((x) => x.page === page)
                .map((x) => {
                  const idx = signers.findIndex((s) => s.id === x.signerId);
                  const who = signers[idx];
                  return (
                    <FieldBox
                      key={x.key}
                      box={x}
                      kind={x.kind}
                      color={signerColor(Math.max(idx, 0))}
                      label={`${x.kind === 'DATE' ? 'Date' : 'Signature'} · ${who?.name || who?.email || ''}`}
                      editable
                      onChange={(b) => f.updateField(x.key, b)}
                      onRemove={() => f.removeField(x.key)}
                    />
                  );
                })
            }
          />
        ) : pdf.status === 'error' ? (
          <p role="alert" className="p-4 text-sm text-state-error">
            {pdf.message}
          </p>
        ) : (
          <PageLoader label="Loading the PDF" className="min-h-[16rem]" />
        )}
      </div>
    </div>
  );
}

function SendStep({ f }: { f: Flow }) {
  const signers = f.draft?.signers ?? [];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line p-3 text-sm">
        <p className="font-medium text-ink">{f.title || 'Untitled'}</p>
        <p className="mt-0.5 text-ink-muted">
          {f.draft?.pageCount} page{f.draft?.pageCount === 1 ? '' : 's'}, {f.fields.length} field
          {f.fields.length === 1 ? '' : 's'}, {signers.length} signer{signers.length === 1 ? '' : 's'}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="signature-message">Message (optional)</Label>
        <Textarea
          id="signature-message"
          rows={3}
          maxLength={2000}
          value={f.message}
          onChange={(e) => f.setMessage(e.target.value)}
          placeholder="Anything the signers should know"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="signature-expiry">Link expires after</Label>
        <select
          id="signature-expiry"
          className="input h-9 w-full text-sm"
          value={f.expiresInDays}
          onChange={(e) => f.setExpiresInDays(Number(e.target.value))}
        >
          {EXPIRY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </select>
      </div>
      {f.busy ? <Loader size="sm" label="Sending" /> : null}
    </div>
  );
}

function SentStep({ result }: { result: NonNullable<Flow['result']> }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (signerId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(signerId);
      setTimeout(() => setCopied((c) => (c === signerId ? null : c)), 1500);
    } catch (err) {
      setCopied(null);
      toastError(err, "Couldn't copy the link. Select it and copy it by hand.");
    }
  };
  return (
    <div className="space-y-3">
      <p
        className={cn(
          'rounded-md px-3 py-2 text-sm',
          result.emailed ? 'bg-tint-info text-ink' : 'bg-tint-warning text-brand-orange',
        )}
      >
        {result.emailed
          ? 'Signing links generated and queued for email delivery. You can also copy a link below.'
          : 'Email transport is not configured on this server. Copy and send each signer their own link below.'}
      </p>
      <ul className="space-y-2">
        {result.links.map((l) => (
          <li key={l.signerId} className="flex items-center gap-2 rounded-md border border-line p-2">
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{l.email}</span>
            {l.code ? <span className="font-mono text-xs text-ink-muted">Code {l.code}</span> : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void copy(l.signerId, l.code ? `${l.url}\nCode: ${l.code}` : l.url)}
            >
              {copied === l.signerId ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
              {copied === l.signerId ? 'Copied' : 'Copy link'}
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-ink-muted">
        Each link signs as that person only and opens with its 6-digit code (copied with the link). Both
        are shown once here and are not stored, so resend from the document if one is lost.
      </p>
    </div>
  );
}
