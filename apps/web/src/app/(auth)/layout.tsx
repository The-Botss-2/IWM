import Link from 'next/link';
import type { ReactNode } from 'react';

import { Logo } from '@/components/branding/logo';

/**
 * Authentication shell - split-screen at ≥ md, single column on mobile.
 * Left (60%) holds the brand wordmark on the blush palette; right (40%)
 * holds a white card with the form, capped at 480px.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen flex bg-bg-app">
      {/* Left - brand panel (hidden on mobile) */}
      <aside className="relative hidden md:flex md:w-3/5 items-center justify-center overflow-hidden p-12">
        <div
          aria-hidden
          className="absolute inset-0 bg-brand-gradient opacity-[0.08]"
        />
        <div
          aria-hidden
          className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-magenta/20 blur-3xl"
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -right-24 h-[28rem] w-[28rem] rounded-full bg-brand-orange/20 blur-3xl"
        />
        <div className="relative z-10 max-w-md">
          <Link
            href="/"
            aria-label="The Botss home"
            className="rounded focus-visible:outline-none focus-visible:shadow-focus inline-block"
          >
            <Logo variant="full" size="lg" />
          </Link>
          <h1 className="mt-10 text-3xl font-semibold text-ink leading-tight">
            One workspace.{' '}
            <span className="text-brand-gradient">Every workflow.</span>
          </h1>
          <p className="mt-4 text-base text-ink-muted leading-relaxed">
            Project management, leads, mail, chat, and documents - built for
            The Botss team across Pakistan.
          </p>
        </div>
      </aside>

      {/* Right - form card */}
      <section className="flex w-full md:w-2/5 items-center justify-center p-6">
        <div className="w-full max-w-[480px] rounded-xl bg-white p-8 shadow-soft">
          <div className="mb-8 flex justify-center md:hidden">
            <Link
              href="/"
              aria-label="The Botss home"
              className="rounded focus-visible:outline-none focus-visible:shadow-focus"
            >
              <Logo variant="full" size="md" />
            </Link>
          </div>
          {children}
        </div>
      </section>
    </main>
  );
}
