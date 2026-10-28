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
    <section className="border-line bg-bg-surface rounded-lg border p-5">
      <div className="text-ink mb-1 flex items-center gap-2 text-sm font-semibold">
        <Send className="text-ink-muted h-4 w-4" aria-hidden /> Sent requests
      </div>
      <p className="text-ink-muted mb-3 text-xs">
        Chat requests you sent to people at other companies. A request stays open for 30 days.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" label="Loading" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-ink-muted py-2 text-xs">You haven&apos;t sent any chat requests.</p>
      ) : (
        <ul role="list" className="divide-line divide-y">
          {items.map((r) => {
            const state = STATE_LABEL[r.state];
            return (
              <li key={r.id} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-ink truncate text-sm font-medium">{r.email}</span>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  <p className="text-ink-muted mt-0.5 truncate text-xs">{r.message}</p>
                  <p
                    className="text-ink-disabled mt-0.5 text-[11px]"
                    title={absoluteTime(r.sentAt)}
                  >
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
    <section className="border-line bg-bg-surface rounded-lg border p-5">
      <div className="text-ink mb-1 flex items-center gap-2 text-sm font-semibold">
        <Ban className="text-ink-muted h-4 w-4" aria-hidden /> Blocked from chat requests
      </div>
      <p className="text-ink-muted mb-3 text-xs">
        People here can&apos;t send you chat requests or message you in a chat between your
        companies. They aren&apos;t told.
      </p>
      {isLoading ? (
        <div className="flex justify-center py-4">
          <Loader size="sm" label="Loading" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-ink-muted py-2 text-xs">You haven&apos;t blocked anyone.</p>
      ) : (
        <ul role="list" className="divide-line divide-y">
          {items.map((b) => {
            const who = b.user.name || b.user.email;
            return (
              <li key={b.user.id} className="flex items-center gap-3 py-2.5">
                <UserAvatar size="sm" name={who} image={b.user.image ?? null} />
                <div className="min-w-0 flex-1">
                  <div className="text-ink truncate text-sm font-medium">{who}</div>
                  <div className="text-ink-muted truncate text-xs">{b.user.email}</div>
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
