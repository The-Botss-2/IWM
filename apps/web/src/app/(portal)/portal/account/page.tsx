'use client';

import type { ReactNode } from 'react';

import { usePortalActiveClient, usePortalMe } from '@/components/portal/portal-context';
import { PortalPageHeader } from '@/components/portal/portal-page-header';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { usePortalPasswordForm } from '@/hooks/use-portal';

export default function PortalAccountPage() {
  const me = usePortalMe();
  const client = usePortalActiveClient();
  const { form, onSubmit, isSubmitting } = usePortalPasswordForm();
  const {
    register,
    formState: { errors },
  } = form;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PortalPageHeader title="Account" description="How you sign in to the client portal." />

      <section aria-labelledby="account-profile" className="card p-5 sm:p-6">
        <h2 id="account-profile" className="text-ink text-base font-semibold">
          Profile
        </h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">Name</dt>
            <dd className="text-ink mt-0.5 text-sm font-medium">{me.user.name || '-'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-ink-muted text-xs">Email</dt>
            <dd className="text-ink mt-0.5 text-sm font-medium">{me.user.email}</dd>
          </div>
        </dl>
        <p className="text-ink-muted mt-4 text-sm">
          To change your name or email, contact{' '}
          {client ? client.agency.name : 'the team that invited you'}.
        </p>
      </section>

      <section aria-labelledby="account-password" className="card p-5 sm:p-6">
        <h2 id="account-password" className="text-ink text-base font-semibold">
          Password
        </h2>
        <p className="text-ink-muted mt-1 text-sm">
          Changing your password signs you out on your other devices. You stay signed in here.
        </p>
        <form className="mt-5 space-y-4" onSubmit={onSubmit} noValidate>
          {/* Lets password managers file the new password under this account. */}
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={me.user.email}
            readOnly
            hidden
          />
          <Field
            id="current-password"
            label="Current password"
            error={errors.currentPassword?.message}
          >
            <PasswordInput
              id="current-password"
              autoComplete="current-password"
              aria-invalid={errors.currentPassword ? true : undefined}
              aria-describedby={errors.currentPassword ? 'current-password-error' : undefined}
              {...register('currentPassword')}
            />
          </Field>
          <Field
            id="new-password"
            label="New password"
            hint="Use at least 8 characters."
            error={errors.newPassword?.message}
          >
            <PasswordInput
              id="new-password"
              autoComplete="new-password"
              aria-invalid={errors.newPassword ? true : undefined}
              aria-describedby={errors.newPassword ? 'new-password-error' : 'new-password-hint'}
              {...register('newPassword')}
            />
          </Field>
          <Field
            id="confirm-password"
            label="Confirm new password"
            error={errors.confirmPassword?.message}
          >
            <PasswordInput
              id="confirm-password"
              autoComplete="new-password"
              aria-invalid={errors.confirmPassword ? true : undefined}
              aria-describedby={errors.confirmPassword ? 'confirm-password-error' : undefined}
              {...register('confirmPassword')}
            />
          </Field>
          <div className="pt-1">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Changing password' : 'Change password'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Label, control, then the hint or the error (the error replaces the hint). */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-state-error text-xs">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-ink-muted text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
