'use client';

import { Eye, LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { exitSupportSession, useActiveSupportSession } from '@/hooks/use-support-access';
import { absoluteTime } from '@/lib/time';

/**
 * Persistent notice while a platform operator browses an organization in a
 * read only support session, on every page, with the way out. Renders
 * nothing outside a support session.
 */
export function SupportSessionBanner() {
  const support = useActiveSupportSession();
  if (!support) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className="border-brand-orange/40 bg-tint-warning text-ink shadow-soft pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-full border px-4 py-2 text-sm"
      >
        <Eye className="text-brand-orange h-4 w-4 shrink-0" aria-hidden />
        <span className="min-w-0">
          Read only support session for{' '}
          <span className="font-semibold">{support.organizationName}</span>, ends{' '}
          <time dateTime={new Date(support.expiresAt).toISOString()}>
            {absoluteTime(support.expiresAt)}
          </time>
        </span>
        <Button size="sm" variant="secondary" onClick={exitSupportSession}>
          <LogOut className="h-4 w-4" aria-hidden />
          Exit
        </Button>
      </div>
    </div>
  );
}
