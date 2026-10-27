'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { InvitationInfo } from '@botss/shared-types';

import { Logo } from '@/components/branding/logo';
import { PageLoader } from '@/components/ui/loader';
import { PasswordInput } from '@/components/ui/password-input';
import { useInvitationAccept } from '@/hooks/use-invitation-accept';

export default function AcceptInvitationPage() {
  // Next.js requires useSearchParams() callers to be wrapped in a Suspense
  // boundary so the surrounding shell can be statically pre-rendered.
  return (
    <Suspense
      fallback={
        <Shell title="Your invitation">
          <PageLoader label="Loading your invitation" className="min-h-[8rem]" />
        </Shell>
      }
    >
      <AcceptInvitationInner />
    </Suspense>
  );
}

function AcceptInvitationInner() {
  const search = useSearchParams();
  const router = useRouter();
  // Only the 32-byte link token opens an invitation. Links of the old
  // `?code=123-456` shape fall through to "missing".
  const token = search.get('token');
  const { state, submitCode, accept } = useInvitationAccept(token);

  useEffect(() => {
    if (state.kind !== 'success') return;
    router.replace(state.destination === 'portal' ? '/portal' : '/home');
    router.refresh();
  }, [state, router]);

  if (state.kind === 'missing') {
    return (
      <Shell title="Open the link from your email">
        <p className="text-sm text-ink-muted">
          Use the button or link in your invitation email. The page it opens asks for the 6-digit
          code printed in the same email. If your link no longer works, ask whoever invited you to
          send a new one.
        </p>
        <Link className="mt-4 inline-block text-sm text-brand-blue hover:underline" href="/sign-in">
          Go to sign-in
        </Link>
      </Shell>
    );
  }

  if (state.kind === 'code') {
    return (
      <Shell title="Enter your code">
        <CodeForm error={state.error} onSubmit={submitCode} />
      </Shell>
    );
  }

  if (state.kind === 'loading') {
    return (
      <Shell title="Your invitation">
        <PageLoader label="Loading your invitation" className="min-h-[8rem]" />
      </Shell>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <Shell title={state.title}>
        <p className="text-sm text-ink-muted">{state.message}</p>
        <Link className="mt-4 inline-block text-sm text-brand-blue hover:underline" href="/sign-in">
          Go to sign-in
        </Link>
      </Shell>
    );
  }

  if (state.kind === 'success') {
    return (
      <Shell title="You're in.">
        <p className="text-sm text-ink-muted">Redirecting…</p>
      </Shell>
    );
  }

  return <ReadyView info={state.info} accept={accept} />;
}

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
      <p className="text-sm text-ink-muted">Type the 6-digit code from your invitation email.</p>
      <div>
        <label
          className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-ink-muted"
          htmlFor="inviteCode"
        >
          Code
        </label>
        <input
          id="inviteCode"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123-456"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-lg border border-line bg-surface px-4 py-2.5 text-center font-mono text-xl tracking-widest text-ink focus:outline-none focus:ring-2 focus:ring-brand-purple"
          autoFocus
          required
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-state-error">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary w-full" disabled={!code.trim()}>
        Continue
      </button>
    </form>
  );
}

function ReadyView({
  info,
  accept,
}: {
  info: InvitationInfo;
  accept: (info: InvitationInfo, password: string) => Promise<string | null>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Client portal links: `workspaceName` carries the company running the
  // portal, and `clientName` the client company the person belongs to.
  const isPortal = info.kind === 'portal-invite' || info.kind === 'portal-reset';
  const isReset = info.kind === 'portal-reset';

  // Existing user with a password - they don't need to set one. Send them to
  // sign-in. The membership row already exists; Better Auth's session will
  // pick up the new workspace on next request. A reset link is the one case
  // where someone with a password still picks a new one.
  if (info.hasPassword && !isReset) {
    return (
      <Shell title={isPortal ? `Your ${info.workspaceName} client portal` : `Join ${info.workspaceName}`}>
        <p className="text-sm text-ink-muted">
          {isPortal ? (
            <>
              Your account <strong>{info.email}</strong> is already set up
              {info.clientName ? (
                <>
                  {' '}and now includes <strong>{info.clientName}</strong>
                </>
              ) : null}
              . Sign in to continue.
            </>
          ) : (
            <>
              {info.inviterName ? `${info.inviterName} invited you` : 'You were invited'} to{' '}
              <strong>{info.workspaceName}</strong> as <strong>{info.email}</strong>. Sign in to
              continue.
            </>
          )}
        </p>
        <Link
          href={isPortal ? '/sign-in' : `/sign-in?next=${encodeURIComponent('/select-workspace')}`}
          className="btn-primary mt-4 inline-flex w-full justify-center"
        >
          Sign in
        </Link>
      </Shell>
    );
  }

  // New user - set a password.
  const passwordsMatch = password === confirm;
  const passwordValid = password.length >= 8;
  const canSubmit = passwordsMatch && passwordValid && !submitting;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!canSubmit) return;
    setSubmitting(true);
    const error = await accept(info, password);
    setSubmitError(error);
    setSubmitting(false);
  }

  return (
    <Shell
      title={
        isReset
          ? 'Choose a new password'
          : isPortal
            ? `Your ${info.workspaceName} client portal`
            : `Welcome to ${info.workspaceName}`
      }
    >
      <p className="text-sm text-ink-muted">
        {isReset ? (
          <>
            Pick a new password for <strong>{info.email}</strong>. It replaces your current one
            and signs you out on your other devices.
          </>
        ) : isPortal ? (
          <>
            {info.inviterName ? `${info.inviterName} invited you` : 'You were invited'} to the
            client portal{info.clientName ? <> for <strong>{info.clientName}</strong></> : null} as{' '}
            <strong>{info.email}</strong>. Pick a password to finish setting up your account.
          </>
        ) : (
          <>
            {info.inviterName ? `${info.inviterName} invited` : 'You were invited as'}{' '}
            <strong>{info.email}</strong>. Pick a password to finish setting up your account.
          </>
        )}
      </p>
      <form onSubmit={onSubmit} className="mt-4 space-y-3" noValidate>
        <div className="space-y-1">
          <label className="label" htmlFor="password">
            New password
          </label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {!passwordValid && password.length > 0 ? (
            <p className="text-xs text-state-error">At least 8 characters.</p>
          ) : null}
        </div>
        <div className="space-y-1">
          <label className="label" htmlFor="confirm">
            Confirm password
          </label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={8}
            required
          />
          {!passwordsMatch && confirm.length > 0 ? (
            <p className="text-xs text-state-error">Passwords don&apos;t match.</p>
          ) : null}
        </div>
        {submitError ? (
          <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
            {submitError}
          </p>
        ) : null}
        <button type="submit" className="btn-primary w-full" disabled={!canSubmit}>
          {submitting ? 'Setting up…' : isReset ? 'Save new password' : 'Accept invitation'}
        </button>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <div className="rounded-lg border border-line bg-bg-surface p-6 shadow-sm">
        <div className="mb-5 flex justify-center">
          <Link
            href="/"
            aria-label="The Botss home"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          >
            <Logo variant="full" size="sm" />
          </Link>
        </div>
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
