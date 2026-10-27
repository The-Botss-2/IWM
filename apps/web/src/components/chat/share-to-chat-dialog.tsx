'use client';

import { useMutation } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ChatRoomSummary } from '@botss/shared-types';

import { UserAvatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useSessionContext } from '@/components/auth/session-gate';
import { useChatRooms } from '@/hooks/use-chat';
import { getApi } from '@/lib/api';
import { roomTitle } from '@/lib/chat-room-label';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  itemType: 'task' | 'timesheet' | 'todo' | 'email';
  itemId: string;
  /** A short label rendered above the picker so users know what they're sharing. */
  itemLabel: string;
}

/**
 * Pick a DM or Group from the user's chat list and POST a reference to
 * `/chat/share`. Channels are intentionally excluded - they're project-
 * scoped and don't fit the cross-app share semantics.
 */
export function ShareToChatDialog({
  open,
  onOpenChange,
  itemType,
  itemId,
  itemLabel,
}: Props) {
  const session = useSessionContext();
  const userId = session.data?.user?.id ?? '';
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(null);

  const rooms = useChatRooms({ enabled: open });

  const candidates = useMemo(() => {
    const items: ChatRoomSummary[] = rooms.data?.items ?? [];
    const q = search.trim().toLowerCase();
    return items
      .filter((r) => r.type === 'DM' || r.type === 'GROUP')
      .filter((r) => {
        if (!q) return true;
        const title = roomTitle(r, userId).toLowerCase();
        return title.includes(q);
      });
  }, [rooms.data, search, userId]);

  const share = useMutation({
    mutationFn: () =>
      getApi().chat.share({
        targetRoomId: picked!,
        itemType,
        itemId,
      }),
    onSuccess: () => {
      toast.success('Shared to chat.');
      onOpenChange(false);
      setPicked(null);
      setSearch('');
    },
    meta: { errorTitle: "Couldn't share to chat" },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share to chat</DialogTitle>
          <DialogDescription>
            Pick a chat to send a reference card for <strong>{itemLabel}</strong>.
            Only DMs and groups in your organization are listed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            placeholder="Search chats"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="max-h-72 space-y-1 overflow-y-auto" role="listbox">
            {candidates.length === 0 ? (
              <li className="px-2 py-4 text-center text-xs text-ink-muted">
                {rooms.isLoading ? (
                  <Loader size="sm" label="Loading" />
                ) : rooms.isError && !rooms.data ? (
                  <QueryError
                    compact
                    message="Couldn't load chats."
                    onRetry={() => void rooms.refetch()}
                  />
                ) : (
                  'No chats to share to.'
                )}
              </li>
            ) : (
              candidates.map((r) => {
                const title = roomTitle(r, userId);
                const peer =
                  r.type === 'DM'
                    ? r.participants.find((p) => p.userId !== userId)?.user
                    : null;
                const active = picked === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => setPicked(r.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                        active ? 'bg-tint-info' : 'hover:bg-bg-subtle',
                      )}
                    >
                      <UserAvatar
                        size="sm"
                        name={title}
                        image={peer?.image ?? null}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-ink">
                          {title}
                        </div>
                        <div className="truncate text-xs text-ink-muted">
                          {r.type === 'DM'
                            ? peer?.email ?? ''
                            : `${r.participants.length} members`}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={share.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => share.mutate()}
            disabled={!picked || share.isPending}
          >
            <Send className="h-3.5 w-3.5" />
            {share.isPending ? 'Sharing…' : 'Share'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
