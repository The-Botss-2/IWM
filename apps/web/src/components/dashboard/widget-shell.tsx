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
      className="shadow-soft hover:shadow-soft-lg rounded-xl bg-white transition-shadow duration-200"
    >
      <header className="border-line flex items-center justify-between border-b px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="text-brand-purple h-4 w-4 shrink-0" aria-hidden />
          <h2 id={`${id}-heading`} className="text-ink whitespace-nowrap text-sm font-semibold">
            {title}
          </h2>
          {subtitle ? (
            <span className="text-ink-muted truncate whitespace-nowrap text-xs">{subtitle}</span>
          ) : null}
        </div>
        {linkHref ? (
          <Link
            href={linkHref}
            className="text-brand-gradient focus-visible:shadow-focus inline-flex items-center gap-0.5 rounded-sm text-xs font-medium hover:underline focus-visible:outline-none"
          >
            {linkLabel ?? 'View all'}
            <ArrowUpRight className="text-brand-purple h-3 w-3" />
          </Link>
        ) : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function WidgetEmpty({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="grid place-items-center py-8 text-center">
      <Icon className="text-line mb-2 h-8 w-8" aria-hidden />
      <p className="text-ink-muted text-xs">{message}</p>
    </div>
  );
}
