'use client';

import { Ban, Send } from 'lucide-react';
import Link from 'next/link';
import type { OutgoingChatRequestState } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader } from '@/components/ui/loader';
import {
  useCancelChatRequest,
  useChatRequestBlocks,
  useOutgoingChatRequests,
  useUnblockChatRequester,
} from '@/hooks/use-chat-requests';
import { absoluteTime, relativeTime } from '@/lib/time';

const STATE_LABEL: Record<OutgoingChatRequestState, { label: string; tone: BadgeProps['tone'] }> = {
  SENT: { label: 'Sent', tone: 'info' },
  ACCEPTED: { label: 'Accepted', tone: 'success' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

/** Chat requests you sent to people at other companies. */
export function SentChatRequestsSection() {
  const { data, isLoading } = useOutgoingChatRequests();
  const cancel = useCancelChatRequest();
  const items = data?.items ?? [];

  return (
    <section className="rounded-lg border border-line bg-bg-surface p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Send className="h-4 w-4 text-ink-muted" aria-hidden /> Sent requests
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        Chat requests you sent to people at other companies. A request stays
        open for 30 days.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" label="Loading" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-xs text-ink-muted">You haven&apos;t sent any chat requests.</p>
      ) : (
        <ul role="list" className="divide-y divide-line">
          {items.map((r) => {
            const state = STATE_LABEL[r.state];
            return (
              <li key={r.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">{r.email}</span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{r.message}</p>
                  <p className="mt-0.5 text-[11px] text-ink-disabled" title={absoluteTime(r.sentAt)}>
                    {relativeTime(r.sentAt)}
                  </p>
                </div>
                {r.state === 'SENT' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => cancel.mutate(r.id)}
                    disabled={cancel.isPending}
                  >
                    Cancel
                  </Button>
                ) : r.state === 'ACCEPTED' && r.roomId ? (
                  <Button size="sm" variant="secondary" asChild>
                    <Link href={`/chat/${r.roomId}`}>Open chat</Link>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** People you blocked from sending you chat requests. */
export function BlockedChatRequestersSection() {
  const { data, isLoading } = useChatRequestBlocks();
  const unblock = useUnblockChatRequester();
  const items = data?.items ?? [];

  return (
    <section className="rounded-lg border border-line bg-bg-surface p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-ink">
        <Ban className="h-4 w-4 text-ink-muted" aria-hidden /> Blocked from chat requests
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        People here can&apos;t send you chat requests or message you in a chat
        between your companies. They aren&apos;t told.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" label="Loading" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-xs text-ink-muted">You haven&apos;t blocked anyone.</p>
      ) : (
        <ul role="list" className="divide-y divide-line">
          {items.map((b) => {
            const who = b.user.name || b.user.email;
            return (
              <li key={b.user.id} className="flex items-center gap-3 py-2.5">
                <UserAvatar size="sm" name={who} image={b.user.image ?? null} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-ink">{who}</div>
                  <div className="truncate text-xs text-ink-muted">{b.user.email}</div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => unblock.mutate(b.user.id)}
                  disabled={unblock.isPending}
                >
                  Unblock
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
