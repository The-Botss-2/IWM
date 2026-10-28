'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCheck,
  CheckCircle2,
  Eraser,
  Hash,
  Info,
  LogOut,
  MessageSquarePlus,
  Phone,
  Search,
  Settings,
  Trash2,
  Volume2,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { ChatRoomSummary, MessageStatus } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { ChatRequestsSection } from '@/components/chat/chat-requests-section';
import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  clearUnread,
  parseCallLog,
  parseShareCard,
  useClearRoomMessages,
  useLeaveRoom,
  useMarkRoomRead,
} from '@/hooks/use-chat';
import { useChatClearedBefore } from '@/hooks/use-chat-cleared-before';
import { roomTitle } from '@/lib/chat-room-label';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Props {
  rooms: ChatRoomSummary[];
  currentUserId: string;
  onNewChat: () => void;
  isLoading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  onlineUserIds?: Set<string>;
}

function isChannel(r: ChatRoomSummary): boolean {
  return r.type === 'TEXT_CHANNEL' || r.type === 'VOICE_CHANNEL';
}

export function ChatSidebar({
  rooms,
  currentUserId,
  onNewChat,
  isLoading,
  loadError,
  onRetry,
  onlineUserIds,
}: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const session = useSessionContext();
  const systemAdmin = session.data?.user?.systemRole === 'ADMIN';
  const cleared = useChatClearedBefore(currentUserId);
  const clearForEveryone = useClearRoomMessages();
  const leave = useLeaveRoom();
  const markRead = useMarkRoomRead();
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<{
    room: ChatRoomSummary;
    position: { x: number; y: number };
  } | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState<ChatRoomSummary | null>(null);
  const [confirmLeave, setConfirmLeave] = useState<ChatRoomSummary | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => {
      const title = roomTitle(r, currentUserId).toLowerCase();
      const last = r.lastMessage?.content?.toLowerCase() ?? '';
      return title.includes(q) || last.includes(q);
    });
  }, [rooms, query, currentUserId]);
  const channels = useMemo(() => filtered.filter(isChannel), [filtered]);
  const chats = useMemo(() => filtered.filter((r) => !isChannel(r)), [filtered]);

  function openMenu(room: ChatRoomSummary, e: React.MouseEvent): void {
    e.preventDefault();
    setMenu({ room, position: { x: e.clientX, y: e.clientY } });
  }

  /**
   * Right-click options resolve against the targeted room. Some are gated
   * by room-admin (creator or anyone explicitly promoted) or by system
   * admin. We treat "no admin recorded" as a legacy room where everyone
   * can manage, matching the server-side `assertRoomAdmin` fallback.
   */
  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return [];
    const room = menu.room;
    const me = room.participants.find((p) => p.userId === currentUserId);
    const adminCount = room.participants.filter((p) => p.role === 'ADMIN').length;
    const isRoomAdmin = adminCount === 0 || me?.role === 'ADMIN';
    // Never for a DM with another organization (the API refuses it too).
    const canClearForEveryone = (isRoomAdmin || systemAdmin) && !room.spansOrganizations;
    const isDM = room.type === 'DM';
    return [
      {
        id: 'mark-read',
        label: 'Mark as read',
        icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
        disabled: (room.unreadCount ?? 0) === 0,
        onSelect: () => {
          // Persist server-side AND optimistically clear the badge so
          // the sidebar feels instant. The mutation handles cache
          // rollback on failure.
          clearUnread(qc, room.id);
          markRead.mutate(room.id);
        },
      },
      {
        id: 'open',
        label: 'Open chat',
        icon: <Info className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () => router.push(`/chat/${room.id}`),
      },
      {
        id: 'clear-for-me',
        label: 'Clear chat for me',
        icon: <Eraser className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () => {
          cleared.clearRoom(room.id);
          toast.success('Cleared on this device.');
        },
      },
      {
        id: 'clear-for-everyone',
        label: 'Delete chat for everyone',
        icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
        destructive: true,
        disabled: !canClearForEveryone,
        onSelect: () => setConfirmClearAll(room),
      },
      ...(!isDM
        ? [
            {
              id: 'leave',
              label: 'Leave',
              icon: <LogOut className="h-3.5 w-3.5" aria-hidden />,
              destructive: true,
              onSelect: () => setConfirmLeave(room),
            } as ContextMenuItem,
          ]
        : []),
    ];
  }, [cleared, currentUserId, markRead, menu, qc, router, systemAdmin]);

  return (
    <div className="bg-bg-surface flex h-full flex-col">
      <header className="border-line flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-ink text-sm font-semibold">Chats</h2>
        <div className="flex items-center gap-1">
          <Link
            href="/settings/communication"
            aria-label="Chat settings"
            title="Chat settings"
            className="text-ink-muted hover:bg-bg-subtle hover:text-ink grid h-8 w-8 place-items-center rounded-full transition-all"
          >
            <Settings className="h-4 w-4" />
          </Link>
          <Button
            variant="gradient"
            size="icon"
            aria-label="New chat"
            onClick={onNewChat}
            className="h-8 min-h-0 w-8 min-w-0"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div className="px-3 py-2">
        <div className="relative">
          <Search
            className="text-ink-muted pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="pl-8"
            aria-label="Search chats"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto" aria-label="Chats">
        <ChatRequestsSection />
        {isLoading ? (
          <div className="flex justify-center px-3 py-6">
            <Loader size="sm" label="Loading" />
          </div>
        ) : loadError ? (
          <div className="p-3">
            <QueryError compact message="Couldn't load chats." onRetry={onRetry} />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-ink-muted px-3 py-6 text-center text-xs">
            {query.trim() ? 'No chats match that search.' : 'No conversations yet.'}
          </p>
        ) : (
          <>
            {channels.length > 0 ? (
              <section aria-labelledby="chat-section-channels">
                <h3
                  id="chat-section-channels"
                  className="text-ink-muted px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wide"
                >
                  Channels
                </h3>
                <ul role="list" className="divide-line divide-y">
                  {channels.map((r) => (
                    <li key={r.id}>
                      <RoomRow
                        room={r}
                        currentUserId={currentUserId}
                        onlineUserIds={onlineUserIds}
                        onContextMenu={openMenu}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {chats.length > 0 ? (
              <section aria-labelledby="chat-section-chats">
                <h3
                  id="chat-section-chats"
                  className="text-ink-muted px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wide"
                >
                  Direct messages
                </h3>
                <ul role="list" className="divide-line divide-y">
                  {chats.map((r) => (
                    <li key={r.id}>
                      <RoomRow
                        room={r}
                        currentUserId={currentUserId}
                        onlineUserIds={onlineUserIds}
                        onContextMenu={openMenu}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </nav>

      <ContextMenu
        position={menu?.position ?? null}
        items={menuItems}
        ariaLabel="Chat actions"
        onClose={() => setMenu(null)}
      />

      <ConfirmDialog
        open={confirmClearAll !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmClearAll(null);
        }}
        title="Delete chat for everyone?"
        description={
          confirmClearAll
            ? `Every message in ${roomTitle(confirmClearAll, currentUserId)} will disappear for all members. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        variant="destructive"
        pending={clearForEveryone.isPending}
        onConfirm={async () => {
          if (!confirmClearAll) return;
          try {
            await clearForEveryone.mutateAsync(confirmClearAll.id);
            setConfirmClearAll(null);
          } catch {
            // Toasted by useClearRoomMessages' onError (a second toast here
            // used to double up).
          }
        }}
      />

      <ConfirmDialog
        open={confirmLeave !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmLeave(null);
        }}
        title="Leave this chat?"
        description={
          confirmLeave
            ? `You won't receive new messages from ${roomTitle(confirmLeave, currentUserId)}.`
            : ''
        }
        confirmLabel="Leave"
        variant="destructive"
        pending={leave.isPending}
        onConfirm={async () => {
          if (!confirmLeave) return;
          try {
            await leave.mutateAsync(confirmLeave.id);
            toast.success('Left chat.');
            setConfirmLeave(null);
          } catch {
            // Toasted by useLeaveRoom's onError (a second toast here used to
            // double up).
          }
        }}
      />
    </div>
  );
}

function RoomRow({
  room,
  currentUserId,
  onlineUserIds,
  onContextMenu,
}: {
  room: ChatRoomSummary;
  currentUserId: string;
  onlineUserIds?: Set<string>;
  onContextMenu?: (room: ChatRoomSummary, e: React.MouseEvent) => void;
}) {
  const pathname = usePathname();
  const href = `/chat/${room.id}`;
  const active = pathname === href;
  const title = roomTitle(room, currentUserId);
  const peerUserId =
    room.type === 'DM' ? room.participants.find((p) => p.userId !== currentUserId)?.userId : null;
  const image =
    room.type === 'DM'
      ? (room.participants.find((p) => p.userId !== currentUserId)?.user.image ?? null)
      : null;
  const peerOnline = peerUserId ? (onlineUserIds?.has(peerUserId) ?? false) : false;
  return (
    <Link
      href={href}
      onContextMenu={(e) => onContextMenu?.(room, e)}
      className={cn(
        'relative flex items-center gap-3 px-4 py-2.5 transition-colors',
        active ? 'bg-bg-subtle' : 'hover:bg-bg-subtle',
      )}
    >
      {active ? (
        <span aria-hidden className="bg-brand-gradient absolute left-0 top-0 h-full w-[3px]" />
      ) : null}
      {isChannel(room) ? (
        <span className="bg-bg-subtle text-brand-purple grid h-10 w-10 shrink-0 place-items-center rounded-full">
          {room.type === 'VOICE_CHANNEL' ? (
            <Volume2 className="h-4 w-4" aria-hidden />
          ) : (
            <Hash className="h-4 w-4" aria-hidden />
          )}
        </span>
      ) : (
        <UserAvatar size="md" name={title} image={image} online={peerOnline} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-ink truncate text-sm font-medium">{title}</span>
          {room.lastMessage ? (
            <span
              className="text-ink-disabled shrink-0 text-[10px]"
              title={absoluteTime(room.lastMessage.createdAt)}
            >
              {relativeTime(room.lastMessage.createdAt)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2">
          <LastMessageSnippet room={room} currentUserId={currentUserId} />
          {room.unreadCount > 0 ? (
            <span className="bg-brand-gradient inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold text-white">
              {room.unreadCount > 99 ? '99+' : room.unreadCount}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function LastMessageSnippet({
  room,
  currentUserId,
}: {
  room: ChatRoomSummary;
  currentUserId: string;
}) {
  if (!room.lastMessage) {
    return <span className="text-ink-disabled truncate text-xs">No messages yet</span>;
  }
  const fromMe = room.lastMessage.senderId === currentUserId;
  const shareCard = parseShareCard(room.lastMessage.content);
  if (shareCard) {
    return (
      <span className="text-ink-muted flex min-w-0 flex-1 items-center gap-1 text-xs">
        <span className="truncate">
          📎 Shared {shareCard.itemType}: {shareCard.title}
        </span>
      </span>
    );
  }
  const callLog = parseCallLog(room.lastMessage.content);
  if (callLog) {
    const label =
      callLog.status === 'COMPLETED'
        ? `Call · ${formatCallDuration(callLog.durationSec)}`
        : callLog.status === 'MISSED'
          ? 'Missed call'
          : 'Call declined';
    return (
      <span className="text-ink-muted flex min-w-0 flex-1 items-center gap-1 text-xs">
        <Phone className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
    );
  }
  return (
    <span className="text-ink-muted flex min-w-0 flex-1 items-center gap-1 text-xs">
      {fromMe ? <StatusTick status={room.lastMessage.status} /> : null}
      <span className="truncate">{room.lastMessage.content ?? '[attachment]'}</span>
    </span>
  );
}

function formatCallDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function StatusTick({ status }: { status: MessageStatus }): ReactNode {
  if (status === 'READ') {
    return <CheckCheck className="text-brand-teal h-3.5 w-3.5 shrink-0" aria-label="Read" />;
  }
  if (status === 'DELIVERED') {
    return <CheckCheck className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-label="Delivered" />;
  }
  return <Check className="text-ink-muted h-3.5 w-3.5 shrink-0" aria-label="Sent" />;
}
