'use client';

import { Phone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';

interface IncomingCallModalProps {
  callerName: string;
  callerImage: string | null;
  onAccept: () => void;
  onDecline: () => void;
}

export function IncomingCallModal({
  callerName,
  callerImage,
  onAccept,
  onDecline,
}: IncomingCallModalProps) {
  return (
    <div
      role="dialog"
      aria-label="Incoming call"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/70"
    >
      <div className="w-[min(360px,90vw)] rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 grid place-items-center">
          <UserAvatar size="lg" name={callerName} image={callerImage} />
        </div>
        <p className="text-xs uppercase tracking-wide text-ink-muted">
          Incoming call
        </p>
        <h2 className="mt-1 text-lg font-semibold text-ink">{callerName}</h2>
        <p className="mt-1 text-xs text-ink-muted">Ringing…</p>
        <div className="mt-6 flex items-center justify-center gap-6">
          <Button
            size="icon"
            aria-label="Decline call"
            onClick={onDecline}
            className="h-14 w-14 rounded-full bg-state-error text-white hover:bg-state-error"
          >
            <Phone className="h-5 w-5 rotate-[135deg]" />
          </Button>
          <Button
            size="icon"
            aria-label="Accept call"
            onClick={onAccept}
            className="h-14 w-14 rounded-full bg-brand-teal text-white hover:bg-emerald-700"
          >
            <Phone className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
