'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  publicOrganizationSignupSchema,
  type PublicOrganizationSignupInput,
} from '@botss/shared-types';

import { OrgMailFields } from '@/components/organization/org-mail-fields';
import { getApi } from '@/lib/api';
import { toastError } from '@/lib/toast';

/**
 * Public organization self-signup - linked from the sign-in page
 * ("Are you an organization? Sign up now"). Creates the tenant org and
 * emails the owner an invitation link where they set their password via
 * the existing /invitations/accept page. No session is created here.
 */
export default function OrgSignupPage() {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [showMail, setShowMail] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PublicOrganizationSignupInput>({
    resolver: zodResolver(publicOrganizationSignupSchema),
    // Drop hidden mail fields from the payload + validation when the optional
    // section is collapsed, so an empty form stays valid. Field defaults
    // (ports, TLS) live on the inputs themselves so a never-mounted mailConfig
    // can't leak a partial object into validation.
    shouldUnregister: true,
  });

  const onSubmit = async (data: PublicOrganizationSignupInput) => {
    try {
      // Defensive: if the section was toggled off, never send a partial block.
      const payload = showMail ? data : { ...data, mailConfig: undefined };
      await getApi().organizations.signup(payload);
      setSubmitted(data.email);
    } catch (err) {
      toastError(err, "Couldn't create your organization");
    }
  };

  if (submitted) {
    return (
      <div className="space-y-4 text-center">
        <h1 className="text-lg font-semibold text-ink">Check your email</h1>
        <p className="text-sm text-ink-muted">
          We sent an invitation to <span className="font-medium text-ink">{submitted}</span>.
          Open it to set your password and finish creating your organization.
          The link is valid for 7 days.
        </p>
        <div className="pt-2">
          <Link
            href="/sign-in"
            className="inline-flex items-center justify-center rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div>
        <h1 className="text-2xl font-semibold">
          Create your <span className="text-brand-gradient">organization</span>
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          Set up a workspace for your team. You&apos;ll receive an email to
          choose your password.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="label" htmlFor="organizationName">Organization name</label>
        <input
          id="organizationName"
          type="text"
          autoComplete="organization"
          className="input"
          {...register('organizationName')}
        />
        {errors.organizationName ? (
          <p className="text-xs text-state-error">{errors.organizationName.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="label" htmlFor="name">Your name</label>
        <input
          id="name"
          type="text"
          autoComplete="name"
          className="input"
          {...register('name')}
        />
        {errors.name ? (
          <p className="text-xs text-state-error">{errors.name.message}</p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="label" htmlFor="email">Work email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          className="input"
          {...register('email')}
        />
        {errors.email ? (
          <p className="text-xs text-state-error">{errors.email.message}</p>
        ) : null}
      </div>

      <div className="rounded-lg border border-line">
        <label className="flex cursor-pointer items-start gap-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-line"
            checked={showMail}
            onChange={(e) => setShowMail(e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-ink">
              Set up email now (optional)
            </span>
            <span className="mt-0.5 block text-xs text-ink-muted">
              Add your SMTP/IMAP details so your organization can send and read
              mail right away. You can also add this later in Settings.
            </span>
          </span>
        </label>
        {showMail ? (
          <div className="border-t border-line p-3">
            <OrgMailFields
              register={register}
              errors={errors}
              prefix="mailConfig."
              passwordsRequired
            />
          </div>
        ) : null}
      </div>

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="spinner-gradient h-4 w-4" />
            Creating…
          </span>
        ) : (
          'Create organization'
        )}
      </button>

      <div className="text-center text-xs text-ink-muted">
        Already have an account?{' '}
        <Link
          href="/sign-in"
          className="font-medium text-brand-600 hover:text-brand-700 hover:underline"
        >
          Sign in
        </Link>
      </div>
    </form>
  );
}
