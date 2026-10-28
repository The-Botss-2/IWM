import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** "Back to ..." link above a detail page's title. */
export function PortalBackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-ink-muted hover:text-ink focus-visible:ring-brand-purple/50 inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      {label}
    </Link>
  );
}

/**
 * Every portal page opens the same way: an optional back link, the title,
 * a line of context (or status badges and dates), and the page's actions.
 */
export function PortalPageHeader({
  title,
  description,
  meta,
  back,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
}) {
  return (
    <header className="space-y-3">
      {back ? <PortalBackLink href={back.href} label={back.label} /> : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="text-ink text-2xl font-semibold">{title}</h1>
          {description ? <p className="text-ink-muted max-w-2xl text-sm">{description}</p> : null}
          {meta ? (
            <div className="text-ink-muted flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
