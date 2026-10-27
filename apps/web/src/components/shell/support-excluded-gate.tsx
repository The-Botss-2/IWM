'use client';

import { EyeOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { useActiveSupportSession } from '@/hooks/use-support-access';

/**
 * Wraps a section that a read only support session never opens (mail,
 * chat). Shows why instead of rendering the section, which would only
 * collect refused requests.
 */
export function SupportExcludedGate({ area, children }: { area: string; children: ReactNode }) {
  const support = useActiveSupportSession();
  if (!support) return <>{children}</>;
  return (
    <div className="grid min-h-[50vh] place-items-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <EyeOff className="h-6 w-6 text-ink-muted" aria-hidden />
        <p className="text-sm font-medium text-ink">{area} is not available in a support session</p>
        <p className="text-sm text-ink-muted">
          {area} is private to each person, so a read only support session can&apos;t open it.
        </p>
      </div>
    </div>
  );
}
