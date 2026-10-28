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
    <main className="bg-bg-app flex min-h-screen">
      {/* Left - brand panel (hidden on mobile) */}
      <aside className="relative hidden items-center justify-center overflow-hidden p-12 md:flex md:w-3/5">
        <div aria-hidden className="bg-brand-gradient absolute inset-0 opacity-[0.08]" />
        <div
          aria-hidden
          className="bg-brand-magenta/20 absolute -left-32 -top-32 h-96 w-96 rounded-full blur-3xl"
        />
        <div
          aria-hidden
          className="bg-brand-orange/20 absolute -bottom-32 -right-24 h-[28rem] w-[28rem] rounded-full blur-3xl"
        />
        <div className="relative z-10 max-w-md">
          <Link
            href="/"
            aria-label="The Botss home"
            className="focus-visible:shadow-focus inline-block rounded focus-visible:outline-none"
          >
            <Logo variant="full" size="lg" />
          </Link>
          <h1 className="text-ink mt-10 text-3xl font-semibold leading-tight">
            One workspace. <span className="text-brand-gradient">Every workflow.</span>
          </h1>
          <p className="text-ink-muted mt-4 text-base leading-relaxed">
            Project management, leads, mail, chat, and documents - built for The Botss team across
            Pakistan.
          </p>
        </div>
      </aside>

      {/* Right - form card */}
      <section className="flex w-full items-center justify-center p-6 md:w-2/5">
        <div className="shadow-soft w-full max-w-[480px] rounded-xl bg-white p-8">
          <div className="mb-8 flex justify-center md:hidden">
            <Link
              href="/"
              aria-label="The Botss home"
              className="focus-visible:shadow-focus rounded focus-visible:outline-none"
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
