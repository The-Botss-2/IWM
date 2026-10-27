'use client';

import { ArrowUpRight, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

interface Props {
  id: string;
  title: string;
  /** Small muted note beside the title, e.g. the date range shown. */
  subtitle?: string | null;
  icon: LucideIcon;
  linkHref?: string;
  linkLabel?: string;
  children: ReactNode;
}

export function WidgetShell({
  id,
  title,
  subtitle,
  icon: Icon,
  linkHref,
  linkLabel,
  children,
}: Props) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="rounded-xl bg-white shadow-soft transition-shadow duration-200 hover:shadow-soft-lg"
    >
      <header className="flex items-center justify-between border-b border-line px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-brand-purple" aria-hidden />
          <h2
            id={`${id}-heading`}
            className="whitespace-nowrap text-sm font-semibold text-ink"
          >
            {title}
          </h2>
          {subtitle ? (
            <span className="truncate whitespace-nowrap text-xs text-ink-muted">{subtitle}</span>
          ) : null}
        </div>
        {linkHref ? (
          <Link
            href={linkHref}
            className="inline-flex items-center gap-0.5 text-xs font-medium text-brand-gradient hover:underline focus-visible:outline-none focus-visible:shadow-focus rounded-sm"
          >
            {linkLabel ?? 'View all'}
            <ArrowUpRight className="h-3 w-3 text-brand-purple" />
          </Link>
        ) : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function WidgetEmpty({
  icon: Icon,
  message,
}: {
  icon: LucideIcon;
  message: string;
}) {
  return (
    <div className="grid place-items-center py-8 text-center">
      <Icon className="mb-2 h-8 w-8 text-line" aria-hidden />
      <p className="text-xs text-ink-muted">{message}</p>
    </div>
  );
}
