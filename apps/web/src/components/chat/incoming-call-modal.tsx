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
      className="bg-ink/70 fixed inset-0 z-[60] flex items-center justify-center"
    >
      <div className="w-[min(360px,90vw)] rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto mb-3 grid place-items-center">
          <UserAvatar size="lg" name={callerName} image={callerImage} />
        </div>
        <p className="text-ink-muted text-xs uppercase tracking-wide">Incoming call</p>
        <h2 className="text-ink mt-1 text-lg font-semibold">{callerName}</h2>
        <p className="text-ink-muted mt-1 text-xs">Ringing…</p>
        <div className="mt-6 flex items-center justify-center gap-6">
          <Button
            size="icon"
            aria-label="Decline call"
            onClick={onDecline}
            className="bg-state-error hover:bg-state-error h-14 w-14 rounded-full text-white"
          >
            <Phone className="h-5 w-5 rotate-[135deg]" />
          </Button>
          <Button
            size="icon"
            aria-label="Accept call"
            onClick={onAccept}
            className="bg-brand-teal h-14 w-14 rounded-full text-white hover:bg-emerald-700"
          >
            <Phone className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
