'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';
import type { IncomingChatRequest } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  useAcceptChatRequest,
  useDeclineChatRequest,
  useIncomingChatRequests,
} from '@/hooks/use-chat-requests';
import { absoluteTime, relativeTime } from '@/lib/time';

/**
 * Pending chat requests from people at other companies, shown at the top of
 * the chat list. Renders nothing when there are none. `/chat?requests=1`
 * (the bell link) scrolls it into view.
 */
export function ChatRequestsSection() {
  return (
    // useSearchParams needs a Suspense boundary for static prerendering.
    <Suspense fallback={null}>
      <ChatRequestsSectionInner />
    </Suspense>
  );
}

function ChatRequestsSectionInner() {
  const { data } = useIncomingChatRequests();
  const items = data?.items ?? [];
  const accept = useAcceptChatRequest();
  const decline = useDeclineChatRequest();
  const focus = useSearchParams().get('requests') === '1';
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focus && items.length > 0) {
      ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [focus, items.length]);

  if (items.length === 0) return null;

  return (
    <section ref={ref} aria-labelledby="chat-section-requests" className="border-b border-line pb-2">
      <h3
        id="chat-section-requests"
        className="px-4 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
      >
        Chat requests
      </h3>
      <ul role="list" className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>
            <RequestRow
              request={r}
              busy={accept.isPending || decline.isPending}
              onAccept={() => accept.mutate(r.id)}
              onDecline={(block) => decline.mutate({ request: r, block })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function RequestRow({
  request,
  busy,
  onAccept,
  onDecline,
}: {
  request: IncomingChatRequest;
  busy: boolean;
  onAccept: () => void;
  onDecline: (block: boolean) => void;
}) {
  const who = request.requester.name || request.requester.email;
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-start gap-3">
        <UserAvatar size="md" name={who} image={request.requester.image ?? null} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium text-ink">{who}</span>
            <span
              className="shrink-0 text-[10px] text-ink-disabled"
              title={absoluteTime(request.sentAt)}
            >
              {relativeTime(request.sentAt)}
            </span>
          </div>
          <div className="truncate text-xs text-ink-muted">
            {request.requester.organizationName
              ? `${request.requester.organizationName} · ${request.requester.email}`
              : request.requester.email}
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-ink">
            {request.message}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button size="sm" onClick={onAccept} disabled={busy}>
              Accept
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onDecline(false)} disabled={busy}>
              Decline
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDecline(true)} disabled={busy}>
              Decline &amp; block
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
