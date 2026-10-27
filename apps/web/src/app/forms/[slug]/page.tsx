'use client';

import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import type { PublicTaskForm } from '@botss/shared-types';

import { Logo } from '@/components/branding/logo';
import { PageLoader } from '@/components/ui/loader';
import { getApi } from '@/lib/api';
import { describeError } from '@/lib/toast';

type Status =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; form: PublicTaskForm }
  | { kind: 'submitting'; form: PublicTaskForm }
  | { kind: 'done'; reference: string };

export default function PublicFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const [state, setState] = useState<Status>({ kind: 'loading' });
  const [values, setValues] = useState<Record<string, string | boolean | number>>({});
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const form = await getApi().taskForms.publicGet(slug);
        if (!cancelled) setState({ kind: 'ready', form });
      } catch (err) {
        if (cancelled) return;
        // Page-load failure is the page's main outcome: keep it inline, but only
        // show a sanitised API message (never raw stack/HTML text).
        setState({ kind: 'error', message: describeError(err, 'Form not found.') });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.kind === 'loading') {
    return (
      <Shell>
        <PageLoader label="Loading form" className="min-h-[8rem]" />
      </Shell>
    );
  }
  if (state.kind === 'error') {
    return (
      <Shell>
        <p className="text-sm text-ink-muted">{state.message}</p>
      </Shell>
    );
  }
  if (state.kind === 'done') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink">Thanks!</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Your request has been recorded as <strong>{state.reference}</strong>. The project team
          will see it on their board.
        </p>
        <Link
          href={`/forms/${slug}`}
          className="mt-4 inline-block text-sm text-brand-blue hover:underline"
        >
          Submit another
        </Link>
      </Shell>
    );
  }

  const form = state.form;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const requiredMissing = form.fields.find(
      (f) => f.required && (values[f.id] === undefined || values[f.id] === ''),
    );
    if (requiredMissing) {
      setError(`Please fill in: ${requiredMissing.label}`);
      return;
    }
    setState({ kind: 'submitting', form });
    try {
      const res = await getApi().taskForms.publicSubmit(slug, {
        payload: values,
        ...(email ? { submittedByEmail: email } : {}),
      });
      setState({ kind: 'done', reference: res.reference });
    } catch (err) {
      const status =
        err && typeof err === 'object' && 'status' in err && typeof err.status === 'number'
          ? err.status
          : 500;
      setError(
        status === 429
          ? 'Too many submissions from your network. Please try again later.'
          : "Couldn't submit. Please try again.",
      );
      setState({ kind: 'ready', form });
    }
  }

  return (
    <Shell>
      <div className="text-xs uppercase tracking-wide text-ink-muted">{form.projectName}</div>
      <h1 className="mt-1 text-lg font-semibold text-ink">{form.name}</h1>
      {form.description ? (
        <p className="mt-2 text-sm text-ink-muted">{form.description}</p>
      ) : null}
      <form className="mt-4 space-y-3" onSubmit={submit} noValidate>
        {form.fields.map((f) => (
          <FieldRow
            key={f.id}
            field={f}
            value={values[f.id]}
            onChange={(v) => setValues((p) => ({ ...p, [f.id]: v }))}
          />
        ))}
        <div className="space-y-1">
          <label className="label" htmlFor="email">
            Your email (optional)
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </div>
        {error ? (
          <p className="rounded-md border border-red-100 bg-tint-error px-3 py-2 text-sm text-state-error">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={state.kind === 'submitting'}
        >
          {state.kind === 'submitting' ? 'Submitting…' : 'Submit'}
        </button>
      </form>
    </Shell>
  );
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: PublicTaskForm['fields'][number];
  value: string | boolean | number | undefined;
  onChange: (v: string | boolean | number) => void;
}) {
  const id = `f_${field.id}`;
  return (
    <div className="space-y-1">
      <label className="label" htmlFor={id}>
        {field.label}
        {field.required ? <span className="ml-1 text-state-error">*</span> : null}
      </label>
      {field.type === 'textarea' ? (
        <textarea
          id={id}
          className="input min-h-[88px]"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === 'select' ? (
        <select
          id={id}
          className="input"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : field.type === 'checkbox' ? (
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : (
        <input
          id={id}
          type={field.type === 'number' ? 'number' : field.type === 'email' ? 'email' : 'text'}
          className="input"
          value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
          onChange={(e) =>
            onChange(
              field.type === 'number' ? Number(e.target.value) : e.target.value,
            )
          }
        />
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}
