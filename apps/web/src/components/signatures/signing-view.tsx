'use client';

import {
  CalendarDays,
  CheckCircle2,
  Download,
  FileSignature,
  PenLine,
  XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { SignatureFieldKind } from '@botss/shared-types';

import { Logo } from '@/components/branding/logo';
import { FieldBox } from '@/components/signatures/field-box';
import { PdfPages } from '@/components/signatures/pdf-pages';
import { SignaturePadDialog } from '@/components/signatures/signature-pad-dialog';
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
import { PageLoader } from '@/components/ui/loader';
import { Textarea } from '@/components/ui/textarea';
import { usePdfDocument } from '@/hooks/use-signatures';
import { useSigningSession, type SigningSource } from '@/hooks/use-signing-session';
import { cn } from '@/lib/utils';

const SIGNER_COLOR = '#4f46e5';

/** The only copy that differs: in the portal the person is signed in, not on a link. */
const COPY = {
  token: {
    until: 'The link works until',
    afterSigning: 'You will get the signed PDF by email once everyone has signed.',
  },
  portal: {
    until: 'You can sign until',
    afterSigning:
      'Once everyone has signed, you can download the signed PDF here. A copy is emailed to you too.',
  },
} as const;

function formatDate(d: Date): string {
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * The signing screen, shared by the emailed link (`/sign/<token>`) and the
 * client portal. On the link it owns the viewport: a logo header, full-height
 * result cards and an action bar fixed to the bottom. In the portal it sits
 * inside the portal shell, so it drops the logo and keeps the action bar in
 * the content column. All state lives in `useSigningSession`.
 */
export function SigningView({ source }: { source: SigningSource }) {
  const standalone = source.kind === 'token';
  const copy = COPY[source.kind];
  const Frame = standalone ? Centered : Inline;
  const Body = standalone ? 'main' : 'div';
  const s = useSigningSession(source);
  const pdf = usePdfDocument(s.session ? s.fileKey : null, s.loadPdf);
  const [padOpen, setPadOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const [placing, setPlacing] = useState<SignatureFieldKind>('SIGNATURE');

  if (s.state.kind === 'code') {
    return (
      <Frame>
        <CodeForm error={s.state.error} onSubmit={s.submitCode} />
      </Frame>
    );
  }
  if (s.state.kind === 'loading') {
    return (
      <Frame>
        <PageLoader label="Opening document" className="min-h-[8rem]" />
      </Frame>
    );
  }
  if (s.state.kind === 'gone') {
    return (
      <Frame>
        <XCircle className="text-ink-disabled mx-auto h-10 w-10" aria-hidden />
        <h1 className="text-ink mt-3 text-center text-lg font-semibold">{s.state.title}</h1>
        <p className="text-ink-muted mt-2 text-center text-sm">{s.state.message}</p>
      </Frame>
    );
  }

  const session = s.state.session;
  const status = session.signer.status;

  if (session.requestStatus === 'COMPLETED') {
    return (
      <Frame>
        <CheckCircle2 className="text-state-success mx-auto h-10 w-10" aria-hidden />
        <h1 className="text-ink mt-3 text-center text-lg font-semibold">Everyone has signed</h1>
        <p className="text-ink-muted mt-2 text-center text-sm">
          &ldquo;{session.title}&rdquo; is complete. A copy was emailed to every signer.
        </p>
        <div className="mt-5 flex justify-center">
          <Button onClick={() => void s.downloadSigned()}>
            <Download className="mr-1.5 h-4 w-4" aria-hidden />
            Download signed PDF
          </Button>
        </div>
      </Frame>
    );
  }
  if (status === 'SIGNED') {
    return (
      <Frame>
        <CheckCircle2 className="text-state-success mx-auto h-10 w-10" aria-hidden />
        <h1 className="text-ink mt-3 text-center text-lg font-semibold">
          {s.done === 'signed' ? 'Thank you, you have signed' : 'You have already signed'}
        </h1>
        <p className="text-ink-muted mt-2 text-center text-sm">
          {session.signersSigned} of {session.signersTotal} people have signed &ldquo;
          {session.title}&rdquo;. {copy.afterSigning}
        </p>
      </Frame>
    );
  }
  if (status === 'DECLINED' || session.requestStatus === 'DECLINED') {
    return (
      <Frame>
        <XCircle className="text-state-error mx-auto h-10 w-10" aria-hidden />
        <h1 className="text-ink mt-3 text-center text-lg font-semibold">
          {status === 'DECLINED' ? 'You declined to sign' : 'This request was declined'}
        </h1>
        <p className="text-ink-muted mt-2 text-center text-sm">
          {status === 'DECLINED'
            ? `${session.requesterName} has been told.`
            : 'Another signer declined, so this request is closed.'}
        </p>
      </Frame>
    );
  }

  const signatureFill = s.adopted ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={s.adopted.imageDataUrl}
      alt="Your signature"
      className="h-full w-full object-contain"
    />
  ) : null;
  const dateFill = s.adopted ? (
    <span className="text-ink truncate px-1 text-[11px] font-medium">{formatDate(new Date())}</span>
  ) : null;

  const needsName = !session.signer.name;

  return (
    <div className={standalone ? 'pb-28' : undefined}>
      {standalone ? (
        <header className="border-line bg-bg-surface border-b">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <Logo variant="full" size="sm" />
            <span className="text-ink-muted truncate text-xs">
              Signing as {session.signer.email}
            </span>
          </div>
        </header>
      ) : null}

      <Body className={standalone ? 'mx-auto max-w-4xl space-y-4 px-4 py-5 sm:px-6' : 'space-y-4'}>
        <section className="border-line bg-bg-surface rounded-lg border p-5 shadow-sm">
          <p className="text-ink-disabled text-[11px] font-medium uppercase tracking-[0.16em]">
            {session.workspaceName}
          </p>
          <h1 className="text-ink mt-1 text-xl font-semibold">{session.title}</h1>
          <p className="text-ink-muted mt-1 text-sm">
            {session.requesterName} asked you to sign this document. {copy.until}{' '}
            {formatDate(new Date(session.expiresAt))}.
          </p>
          {session.message ? (
            <p className="bg-bg-subtle text-ink mt-3 whitespace-pre-wrap rounded-md p-3 text-sm">
              {session.message}
            </p>
          ) : null}
          {needsName ? (
            <div className="mt-4 max-w-sm space-y-1.5">
              <Label htmlFor="signer-name">Your full name</Label>
              <Input
                id="signer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={120}
              />
            </div>
          ) : null}
          <ol className="text-ink mt-4 space-y-1 text-sm">
            {s.canPlace ? (
              <li>1. Pick Signature or Date below, then click the page where it should go.</li>
            ) : (
              <li>1. Read the document. Your boxes are highlighted.</li>
            )}
            <li>2. Adopt your signature: draw it or type it.</li>
            <li>3. Press Finish.</li>
          </ol>
        </section>

        {s.canPlace ? (
          <div
            className="flex flex-wrap items-center gap-2"
            role="radiogroup"
            aria-label="Field to place"
          >
            {(['SIGNATURE', 'DATE'] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={placing === k}
                onClick={() => setPlacing(k)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                  placing === k
                    ? 'border-brand-purple bg-brand-50 text-brand-700'
                    : 'border-line bg-bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {k === 'SIGNATURE' ? (
                  <PenLine className="h-4 w-4" aria-hidden />
                ) : (
                  <CalendarDays className="h-4 w-4" aria-hidden />
                )}
                {k === 'SIGNATURE' ? 'Signature' : 'Date'}
              </button>
            ))}
            <span className="text-ink-muted text-xs">
              Click the page to place it. Drag to adjust.
            </span>
          </div>
        ) : null}

        {pdf.status === 'ready' ? (
          <PdfPages
            doc={pdf.doc}
            onPageClick={s.canPlace ? (page, point) => s.placeAt(page, point, placing) : undefined}
            overlay={(page) =>
              s.fields
                .filter((f) => f.box.page === page)
                .map((f) => (
                  <FieldBox
                    key={f.key}
                    box={f.box}
                    kind={f.kind}
                    color={SIGNER_COLOR}
                    label={f.kind === 'DATE' ? 'Date' : s.adopted ? 'Your signature' : 'Sign here'}
                    editable={f.mine}
                    onChange={f.mine ? (b) => s.updatePlaced(f.key, b) : undefined}
                    onRemove={f.mine ? () => s.removePlaced(f.key) : undefined}
                    onActivate={() => setPadOpen(true)}
                    filled={f.kind === 'DATE' ? dateFill : signatureFill}
                    highlighted={!s.adopted && f.kind === 'SIGNATURE'}
                  />
                ))
            }
          />
        ) : pdf.status === 'error' ? (
          <p
            role="alert"
            className="border-line bg-bg-surface text-state-error rounded-md border p-4 text-sm"
          >
            {pdf.message}
          </p>
        ) : (
          <PageLoader label="Loading the document" className="min-h-[12rem]" />
        )}
      </Body>

      <div
        className={
          standalone
            ? 'border-line bg-bg-surface/95 fixed inset-x-0 bottom-0 z-30 border-t backdrop-blur [padding-bottom:env(safe-area-inset-bottom)]'
            : 'border-line bg-bg-surface/95 shadow-soft sticky bottom-3 z-20 mt-4 rounded-lg border backdrop-blur [padding-bottom:env(safe-area-inset-bottom)]'
        }
      >
        <div
          className={
            standalone
              ? 'mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-3 sm:px-6'
              : 'flex flex-wrap items-center gap-2 px-4 py-3'
          }
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeclineOpen(true)}
            disabled={s.submitting}
          >
            Decline
          </Button>
          <div className="flex-1" />
          <Button variant="secondary" onClick={() => setPadOpen(true)} disabled={s.submitting}>
            <FileSignature className="mr-1.5 h-4 w-4" aria-hidden />
            {s.adopted ? 'Change signature' : 'Adopt signature'}
          </Button>
          <Button
            onClick={() => void s.submit(needsName ? name : undefined)}
            disabled={!s.ready || (needsName && name.trim().length === 0)}
            title={
              !s.adopted
                ? 'Adopt your signature first'
                : s.canPlace && !s.fields.some((f) => f.kind === 'SIGNATURE')
                  ? 'Place your signature on the page first'
                  : undefined
            }
          >
            {s.submitting ? 'Signing...' : 'Finish'}
          </Button>
        </div>
      </div>

      <SignaturePadDialog
        open={padOpen}
        onOpenChange={setPadOpen}
        defaultName={session.signer.name ?? name}
        onAdopt={s.setAdopted}
      />

      <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">Decline to sign?</DialogTitle>
            <DialogDescription className="text-ink-muted text-sm">
              {session.requesterName} will see your reason. The request closes for everyone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="decline-reason">Reason</Label>
            <Textarea
              id="decline-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeclineOpen(false)}>
              Keep reviewing
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length === 0 || s.submitting}
              onClick={() => {
                void s.decline(reason.trim()).then(() => setDeclineOpen(false));
              }}
            >
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Emailed link: the 6-digit code from the same email, checked by the API. */
function CodeForm({ error, onSubmit }: { error: string | null; onSubmit: (code: string) => void }) {
  const [code, setCode] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) onSubmit(code);
      }}
      className="space-y-4"
    >
      <h1 className="text-ink text-center text-lg font-semibold">Enter your code</h1>
      <p className="text-ink-muted text-center text-sm">
        Type the 6-digit code from the email that brought you here.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="signing-code">Code</Label>
        <Input
          id="signing-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123-456"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          autoFocus
          className="text-center font-mono text-xl tracking-widest"
        />
      </div>
      {error ? (
        <p role="alert" className="text-state-error text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={!code.trim()}>
        Continue
      </Button>
    </form>
  );
}

/** The emailed link has no app shell: a full-height card with the logo. */
function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="border-line bg-bg-surface rounded-lg border p-6 shadow-sm">
        <div className="mb-5 flex justify-center">
          <Logo variant="full" size="sm" />
        </div>
        {children}
      </div>
    </div>
  );
}

/** The same card inside the portal shell: no logo, no viewport height. */
function Inline({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-md py-6">
      <div className="border-line bg-bg-surface rounded-lg border p-6 shadow-sm">{children}</div>
    </div>
  );
}
