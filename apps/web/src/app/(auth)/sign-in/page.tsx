'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { signInSchema, type SignInInput } from '@botss/shared-types';

import { PasswordInput } from '@/components/ui/password-input';
import { authClient } from '@/lib/auth-client';
import { landingPathAfterSignIn } from '@/lib/session-query';
import { describeError } from '@/lib/toast';

export default function SignInPage() {
  return (
    <Suspense fallback={<SignInFormSkeleton />}>
      <SignInForm />
    </Suspense>
  );
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { rememberMe: true },
  });

  // Recovery path: if the page reloaded because the user submitted while JS
  // was still hydrating, the credentials may have landed in the URL as
  // ?email=&password=. Rehydrate the form and strip them from history so the
  // URL bar / browser history / referer header stays clean.
  useEffect(() => {
    const email = searchParams.get('email');
    const password = searchParams.get('password');
    if (email || password) {
      if (email) setValue('email', email);
      if (password) setValue('password', password);
      window.history.replaceState(null, '', '/sign-in');
    }
  }, [searchParams, setValue]);

  const onSubmit = async (data: SignInInput, e?: React.BaseSyntheticEvent) => {
    if (e) e.preventDefault();
    setSubmitError(null);
    try {
      const res = await authClient.signIn.email({
        email: data.email,
        password: data.password,
        rememberMe: data.rememberMe,
      });

      if (res?.error) {
        if (res.error.status === 401 || res.error.status === 403) {
          setSubmitError(
            'Invalid email or password. Team members: ask your administrator to reset your password. Client portal users: ask your contact for a new password link.',
          );
        } else if (res.error.status === 429) {
          setSubmitError(
            'Too many sign-in attempts from this network. Wait a few minutes, then try again.',
          );
        } else {
          setSubmitError(describeError(res.error, "Couldn't sign in."));
        }
        return;
      }

      window.location.replace(await landingPathAfterSignIn());
    } catch (err) {
      // Inline under the form (the established sign-in UX). Network failures
      // read as "Couldn't reach the server..." instead of a generic message.
      setSubmitError(describeError(err, 'An unexpected error occurred. Please try again.'));
    }
  };

  return (
    <form className="space-y-5" method="post" onSubmit={handleSubmit(onSubmit)} noValidate>
      <div>
        <h1 className="text-2xl font-semibold">
          Welcome <span className="text-brand-gradient">back</span>
        </h1>
        <p className="text-ink-muted mt-1 text-sm">Sign in to your workspace.</p>
      </div>

      <div className="space-y-1.5">
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          className="input"
          {...register('email')}
        />
        {errors.email ? <p className="text-state-error text-xs">{errors.email.message}</p> : null}
      </div>

      <div className="space-y-1.5">
        <label className="label" htmlFor="password">
          Password
        </label>
        <PasswordInput id="password" autoComplete="current-password" {...register('password')} />
        {errors.password ? (
          <p className="text-state-error text-xs">{errors.password.message}</p>
        ) : null}
      </div>

      <label
        htmlFor="rememberMe"
        className="text-ink-muted flex select-none items-center gap-2 text-sm"
      >
        <input
          id="rememberMe"
          type="checkbox"
          className="border-line text-brand-600 focus-visible:shadow-focus h-4 w-4 rounded focus-visible:ring-2"
          {...register('rememberMe')}
        />
        Remember me
      </label>

      {submitError ? (
        <p className="bg-tint-error text-state-error border-state-error/30 rounded-md border px-3 py-2 text-sm">
          {submitError}
        </p>
      ) : null}

      <button type="submit" className="btn-primary w-full" disabled={isSubmitting}>
        {isSubmitting ? (
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="spinner-gradient h-4 w-4" />
            Signing in…
          </span>
        ) : (
          'Sign in'
        )}
      </button>

      <div className="text-ink-muted text-center text-xs">
        Admin-managed accounts only. Ask your administrator if you need a password reset.
      </div>

      <div className="border-line text-ink-muted border-t pt-4 text-center text-sm">
        Are you an organization?{' '}
        <Link
          href="/org-signup"
          className="text-brand-600 hover:text-brand-700 font-medium hover:underline"
        >
          Sign up now
        </Link>
      </div>
    </form>
  );
}

function SignInFormSkeleton() {
  return (
    <div className="space-y-4">
      <div className="bg-bg-subtle h-9 animate-pulse rounded" />
      <div className="bg-bg-subtle h-9 animate-pulse rounded" />
      <div className="bg-line h-10 animate-pulse rounded" />
    </div>
  );
}
