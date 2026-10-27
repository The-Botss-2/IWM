'use client';

import { forwardRef } from 'react';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';

/**
 * Shared SMTP/IMAP input grid for the organization mail config. Used by both
 * the public org-signup form (prefix `mailConfig.`, passwords required) and the
 * in-app settings page (no prefix, passwords optional - blank keeps the stored
 * value). The register/errors are typed loosely because the two host forms have
 * different shapes; the field names below are the single source of correctness.
 */
export function OrgMailFields({
  register,
  errors,
  // Prefix applied to every field name, e.g. 'mailConfig.' when the block is
  // nested inside a larger form. Empty when the form is mail-config only.
  prefix = '',
  passwordsRequired,
  passwordPlaceholder,
}: {
  // any: the signup form and the settings form have different shapes but share
  // this exact field grid, so we accept either form's register/errors here.
  register: UseFormRegister<any>;
  errors: FieldErrors<any>;
  prefix?: '' | 'mailConfig.';
  passwordsRequired: boolean;
  passwordPlaceholder?: string;
}) {
  const name = (field: string) => `${prefix}${field}`;
  // Pull a nested error message (handles the `mailConfig.smtpHost` path).
  const errMsg = (field: string): string | undefined => {
    const group = prefix
      ? (errors as Record<string, Record<string, { message?: string }>>)['mailConfig']
      : (errors as Record<string, { message?: string }>);
    const node = group?.[field as keyof typeof group] as { message?: string } | undefined;
    return node?.message;
  };

  return (
    <div className="space-y-4">
      <Section title="Outgoing mail (SMTP)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <Field label="SMTP host" error={errMsg('smtpHost')}>
            <input className="input" placeholder="smtp.example.com" {...register(name('smtpHost'))} />
          </Field>
          <Field label="Port" error={errMsg('smtpPort')}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              defaultValue={587}
              {...register(name('smtpPort'), { valueAsNumber: true })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="SMTP username" error={errMsg('smtpUser')}>
            <input className="input" autoComplete="off" {...register(name('smtpUser'))} />
          </Field>
          <Field
            label={passwordsRequired ? 'SMTP password' : 'SMTP password (leave blank to keep)'}
            error={errMsg('smtpPassword')}
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={passwordPlaceholder}
              {...register(name('smtpPassword'))}
            />
          </Field>
        </div>
        <Checkbox label="Use TLS/SSL for SMTP" {...register(name('smtpSecure'))} />
      </Section>

      <Section title="Incoming mail (IMAP)">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
          <Field label="IMAP host" error={errMsg('imapHost')}>
            <input className="input" placeholder="imap.example.com" {...register(name('imapHost'))} />
          </Field>
          <Field label="Port" error={errMsg('imapPort')}>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              defaultValue={993}
              {...register(name('imapPort'), { valueAsNumber: true })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="IMAP username" error={errMsg('imapUser')}>
            <input className="input" autoComplete="off" {...register(name('imapUser'))} />
          </Field>
          <Field
            label={passwordsRequired ? 'IMAP password' : 'IMAP password (leave blank to keep)'}
            error={errMsg('imapPassword')}
          >
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder={passwordPlaceholder}
              {...register(name('imapPassword'))}
            />
          </Field>
        </div>
        <Checkbox label="Use TLS/SSL for IMAP" defaultChecked {...register(name('imapSecure'))} />
      </Section>

      <Field label="From address" error={errMsg('fromEmail')}>
        <input
          className="input"
          type="email"
          placeholder="team@example.com"
          {...register(name('fromEmail'))}
        />
      </Field>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-line p-3">
      <legend className="px-1 text-xs font-semibold text-ink-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="label">{label}</label>
      {children}
      {error ? <p className="text-xs text-state-error">{error}</p> : null}
    </div>
  );
}

// forwardRef so react-hook-form's register ref reaches the actual checkbox -
// without it the uncontrolled checked value would never be captured on submit.
const Checkbox = forwardRef<
  HTMLInputElement,
  { label: string } & React.InputHTMLAttributes<HTMLInputElement>
>(function Checkbox({ label, ...rest }, ref) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink">
      <input ref={ref} type="checkbox" className="h-4 w-4 rounded border-line" {...rest} />
      {label}
    </label>
  );
});
