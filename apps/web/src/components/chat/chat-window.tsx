'use client';

import {
  ArrowLeft,
  Ban,
  Check,
  CheckCheck,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Copy,
  CornerUpLeft,
  Download,
  ExternalLink,
  Forward,
  Hash,
  Info,
  Link2,
  Loader2,
  Pencil,
  Phone,
  PhoneMissed,
  Search,
  Smile,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatRoomMessage, ChatRoomSummary } from '@botss/shared-types';
import { isRiskyFile } from '@botss/shared-types';

import {
  ChatInput,
  abortChatAttachmentUpload,
  type ChatInputHandle,
} from '@/components/chat/chat-input';
import { ChatMarkdown } from '@/components/chat/chat-markdown';
import { VoiceMessage } from '@/components/chat/voice-message';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { UserAvatar } from '@/components/ui/avatar';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/context-menu';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import {
  chatMessagesKey,
  chatRoomsKey,
  clearUnread,
  formatSystemMessage,
  parseCallLog,
  parseShareCard,
  parseSystemMessage,
  removeRoomMessage,
  useChatRooms,
  useDeleteMessage,
  useForwardMessages,
  useLoadOlderMessages,
  useMarkRoomRead,
  useRoomMessages,
  useToggleReaction,
} from '@/hooks/use-chat';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCrossOrgDmBlock } from '@/hooks/use-chat-requests';
import { useRoomRealtime } from '@/hooks/use-chat-socket';
import { useChatClearedBefore } from '@/hooks/use-chat-cleared-before';
import { useDebouncedValue } from '@/hooks/use-debounced';
import { useHiddenMessages } from '@/hooks/use-hidden-messages';
import { useRoomMessageSearch } from '@/hooks/use-search';
import { fontSizeClass, useChatAppearance } from '@/lib/chat-prefs';
import { roomTitle } from '@/lib/chat-room-label';
import { getChatSocket } from '@/lib/chat-socket';
import type { MessagesPurgedPayload, TypingPayload } from '@/lib/chat-socket-events';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast, toastErrorMessage } from '@/lib/toast';
import { downloadUrl } from '@/lib/download-url';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';

interface Props {
  room: ChatRoomSummary;
  currentUserId: string;
  onStartCall: (roomId: string, peerUserId?: string) => void;
  onOpenInfo: () => void;
  /** Scroll to and flash this message, e.g. when arriving from search. */
  focusMessageId?: string | null;
}

/** How many older pages to pull while looking for a linked message. */
const FOCUS_MAX_PAGES = 15;

interface ReplyTarget {
  id: string;
  senderName: string;
  content: string | null;
}

const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface TypingMap {
  [userId: string]: number;
}

export function ChatWindow({
  room,
  currentUserId,
  onStartCall,
  onOpenInfo,
  focusMessageId,
}: Props) {
  const { data, isLoading, isError, refetch } = useRoomMessages(room.id);
  const qc = useQueryClient();
  useRoomRealtime(room.id, currentUserId);
  const toggleReaction = useToggleReaction();
  const deleteMessage = useDeleteMessage();
  const markRoomRead = useMarkRoomRead();
  const forwardMessages = useForwardMessages();
  const loadOlder = useLoadOlderMessages(room.id);
  const hidden = useHiddenMessages(currentUserId);
  const cleared = useChatClearedBefore(currentUserId);
  // Cross-organization DM only: block / unblock the other person.
  const dmBlock = useCrossOrgDmBlock(room, currentUserId);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const [typing, setTyping] = useState<TypingMap>({});
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [editingMessage, setEditingMessage] = useState<ChatRoomMessage | null>(null);
  // Multi-select forward mode. `selectedIds` is the working set; the forward
  // dialog opens with whatever ids are pending in `forwardIds`.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [forwardIds, setForwardIds] = useState<string[] | null>(null);
  // Right-click menu for an attachment (image or file): download / open / copy.
  const [attachMenu, setAttachMenu] = useState<{
    fileUrl: string;
    fileName: string;
    position: { x: number; y: number };
  } | null>(null);

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Pane-level drag-and-drop: dropping a file anywhere on the conversation
  // forwards it to the composer (`inputRef.addFiles`). The counter rides out
  // dragenter/dragleave firing on child elements so the overlay doesn't flicker.
  const inputRef = useRef<ChatInputHandle>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragCounter = useRef(0);
  const [msgMenu, setMsgMenu] = useState<{
    message: ChatRoomMessage;
    position: { x: number; y: number };
  } | null>(null);
  const appearance = useChatAppearance();
  const isDark = appearance.theme === 'dark';

  /**
   * Visible messages = server set minus (this user's hidden IDs) minus
   * (anything older than this user's "Clear chat for me" timestamp for
   * this room) minus the server-soft-deleted ones (which we keep listed
   * but render with a "(message deleted)" placeholder, see MessageBubble).
   */
  const clearedBefore = cleared.clearedBefore(room.id);
  const allMessages = useMemo(() => data?.items ?? [], [data]);
  const messages = useMemo(() => {
    return allMessages.filter((m) => {
      if (hidden.isHidden(m.id)) return false;
      if (clearedBefore != null && m.createdAt.getTime() < clearedBefore) {
        return false;
      }
      return true;
    });
  }, [allMessages, hidden, clearedBefore]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyBottomRef = useRef(true);

  // Am I a room admin? Used to gate "Delete for everyone" on others'
  // messages and to silently allow legacy rooms (zero admins recorded) to
  // function as if everyone is admin.
  const isRoomAdmin = useMemo(() => {
    // A DM with another organization: nobody moderates the other side.
    if (room.spansOrganizations) return false;
    const adminCount = room.participants.filter((p) => p.role === 'ADMIN').length;
    if (adminCount === 0) return true;
    return room.participants.find((p) => p.userId === currentUserId)?.role === 'ADMIN';
  }, [room.participants, room.spansOrganizations, currentUserId]);

  useEffect(() => {
    if (!stickyBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Abandon any in-progress edit / selection / forward when the room changes so
  // state from one conversation can't bleed into another.
  useEffect(() => {
    setEditingMessage(null);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setForwardIds(null);
    setAttachMenu(null);
  }, [room.id]);

  useEffect(() => {
    // Persistent mark-as-read: hits the REST endpoint so the change
    // survives reload, plus the optimistic `clearUnread` keeps the
    // sidebar badge instantly responsive. Falls through silently if the
    // network is down - the cache-only path still flips the local view.
    clearUnread(qc, room.id);
    markRoomRead.mutate(room.id);
    // We intentionally exclude `markRoomRead` from deps - its identity
    // changes every render and we only want to fire on room change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, room.id]);

  /**
   * Live update when somebody else (or you on another device) deletes a
   * message or wipes the room. The server soft-deletes; we just refresh
   * the cached list so the affected rows render as "deleted" / disappear.
   */
  useEffect(() => {
    const socket = getChatSocket();
    const onPurged = (payload: MessagesPurgedPayload) => {
      if (payload.roomId !== room.id) return;
      void qc.invalidateQueries({ queryKey: chatMessagesKey(room.id) });
      void qc.invalidateQueries({ queryKey: chatRoomsKey });
    };
    socket.on('messages_purged', onPurged);
    return () => {
      socket.off('messages_purged', onPurged);
    };
  }, [qc, room.id]);

  useEffect(() => {
    const socket = getChatSocket();
    const onStart = (payload: TypingPayload) => {
      if (payload.roomId !== room.id) return;
      if (payload.userId === currentUserId) return;
      setTyping((prev) => ({ ...prev, [payload.userId]: Date.now() }));
    };
    const onStop = (payload: TypingPayload) => {
      if (payload.roomId !== room.id) return;
      setTyping((prev) => {
        const next = { ...prev };
        delete next[payload.userId];
        return next;
      });
    };
    socket.on('typing_start', onStart);
    socket.on('typing_stop', onStop);
    return () => {
      socket.off('typing_start', onStart);
      socket.off('typing_stop', onStop);
    };
  }, [currentUserId, room.id]);

  // Expire stale typing indicators. Only ticks while someone is typing, and
  // returns the previous object when nothing expired so idle rooms don't
  // re-render the whole window every 1.5s.
  const someoneTyping = Object.keys(typing).length > 0;
  useEffect(() => {
    if (!someoneTyping) return;
    const interval = setInterval(() => {
      setTyping((prev) => {
        const now = Date.now();
        let changed = false;
        const next: TypingMap = {};
        for (const [uid, ts] of Object.entries(prev)) {
          if (now - ts < 5_000) next[uid] = ts;
          else changed = true;
        }
        return changed ? next : prev;
      });
    }, 1_500);
    return () => clearInterval(interval);
  }, [someoneTyping]);

  const openMsgMenu = useCallback((message: ChatRoomMessage, e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setMsgMenu({ message, position: { x: e.clientX, y: e.clientY } });
  }, []);

  const openAttachMenu = useCallback(
    (attachment: { fileUrl: string; fileName: string }, e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      setAttachMenu({
        fileUrl: attachment.fileUrl,
        fileName: attachment.fileName,
        position: { x: e.clientX, y: e.clientY },
      });
    },
    [],
  );

  // Participant lookups, rebuilt only when the member list changes. Keeping
  // these referentially stable lets the memoized MessageGroup/MessageBubble
  // rows skip re-rendering on unrelated window state changes.
  /** userId -> display name (`name`, falling back to email). */
  const participantsById = useMemo<Record<string, string>>(
    () => Object.fromEntries(room.participants.map((p) => [p.userId, p.user.name || p.user.email])),
    [room.participants],
  );
  /** userId -> `user.name` (nullable), used for sender labels. */
  const senderNameById = useMemo(
    () => new Map(room.participants.map((p) => [p.userId, p.user.name] as const)),
    [room.participants],
  );

  const onReplyMessage = useCallback(
    (m: ChatRoomMessage) =>
      setReplyTo({
        id: m.id,
        senderName: senderNameById.get(m.senderId) ?? 'Member',
        content: m.content,
      }),
    [senderNameById],
  );
  const reactMutate = toggleReaction.mutate;
  const onReactMessage = useCallback(
    (messageId: string, emoji: string) => reactMutate({ messageId, emoji }),
    [reactMutate],
  );

  // Load the previous page and keep the viewport anchored on the message the
  // user was looking at (prepending older rows would otherwise jump the view).
  const onLoadOlder = async () => {
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    stickyBottomRef.current = false;
    try {
      await loadOlder.mutateAsync();
    } catch {
      return; // toasted by useLoadOlderMessages' onError
    }
    requestAnimationFrame(() => {
      const el2 = scrollRef.current;
      if (el2) el2.scrollTop = el2.scrollHeight - prevHeight;
    });
  };

  const beginForward = (messageIds: string[]) => {
    if (messageIds.length === 0) return;
    setForwardIds(messageIds);
  };

  const msgMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!msgMenu) return [];
    const m = msgMenu.message;
    const isMine = m.senderId === currentUserId;
    const canDeleteForEveryone = (isMine || isRoomAdmin) && !m.deletedAt;
    const isCallLog = parseCallLog(m.content) !== null;
    const isShare = parseShareCard(m.content) !== null;
    const items: ContextMenuItem[] = [];
    if (!isCallLog && !m.deletedAt) {
      items.push({
        id: 'reply',
        label: 'Reply',
        icon: <CornerUpLeft className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () =>
          setReplyTo({
            id: m.id,
            senderName:
              room.participants.find((p) => p.userId === m.senderId)?.user.name ?? 'Member',
            content: m.content,
          }),
      });
      if (m.content) {
        items.push({
          id: 'copy',
          label: 'Copy text',
          icon: <Copy className="h-3.5 w-3.5" aria-hidden />,
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText(m.content ?? '');
              toast.success('Copied.');
            } catch {
              toastErrorMessage("Couldn't copy", {
                description:
                  'Your browser blocked clipboard access. Allow it in site settings, or copy it by hand.',
              });
            }
          },
        });
      }
      // Edit: own, non-deleted, plain text messages only (not call logs or
      // share cards, whose body is a structured marker string).
      if (isMine && !isCallLog && !isShare && m.content) {
        items.push({
          id: 'edit',
          label: 'Edit',
          icon: <Pencil className="h-3.5 w-3.5" aria-hidden />,
          onSelect: () => {
            setReplyTo(null);
            setEditingMessage(m);
          },
        });
      }
      items.push({
        id: 'forward',
        label: 'Forward',
        icon: <Forward className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () => beginForward([m.id]),
      });
      items.push({
        id: 'select',
        label: 'Select messages',
        icon: <CheckSquare className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () => {
          setSelectionMode(true);
          setSelectedIds(new Set([m.id]));
        },
      });
    }
    items.push({
      id: 'delete-for-me',
      label: 'Delete for me',
      icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
      destructive: true,
      onSelect: () => hidden.hide(m.id),
    });
    items.push({
      id: 'delete-for-everyone',
      label: 'Delete for everyone',
      icon: <Trash2 className="h-3.5 w-3.5" aria-hidden />,
      destructive: true,
      disabled: !canDeleteForEveryone,
      onSelect: () => {
        deleteMessage.mutate(m.id);
      },
    });
    return items;
  }, [currentUserId, deleteMessage, hidden, isRoomAdmin, msgMenu, room.participants]);

  const isChannel = room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL';
  const peer = useMemo(
    () =>
      room.type === 'DM'
        ? (room.participants.find((p) => p.userId !== currentUserId) ?? null)
        : null,
    [room, currentUserId],
  );
  const titleName = isChannel
    ? (room.name ?? (room.type === 'VOICE_CHANNEL' ? 'voice' : 'channel'))
    : room.type === 'GROUP'
      ? (room.name ?? 'Group')
      : (peer?.user.name ?? peer?.user.email ?? 'Conversation');
  const titleImage = peer?.user.image ?? null;

  const grouped = useMemo(() => groupBySender(messages), [messages]);

  // In-conversation search (Slack / WhatsApp style). Two sources, merged:
  //  - the loaded messages, filtered locally (instant, includes realtime
  //    arrivals and rooms the user can read without having joined);
  //  - after a 300 ms pause, the server's search of the WHOLE room (newest 50
  //    hits), so matches that are not loaded yet are found too. Only run for
  //    participants: the server searches rooms the caller belongs to.
  // Stepping to a hit that is not loaded yet pulls older pages until it is on
  // screen. Each jump scrolls the message into view and rings it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // The match the user stepped to; null = the most recent one. Held by id so
  // the list growing (older pages, new messages) keeps the user's place.
  const [pickedMatchId, setPickedMatchId] = useState<string | null>(null);
  const isParticipant = useMemo(
    () => room.participants.some((p) => p.userId === currentUserId),
    [room.participants, currentUserId],
  );
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const roomSearch = useRoomMessageSearch(room.id, debouncedSearch, searchOpen && isParticipant);
  const localMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as { id: string; at: number }[];
    return messages
      .filter((m) => {
        const c = m.content;
        if (!c || m.deletedAt) return false;
        if (
          c.startsWith('__call__:') ||
          c.startsWith('__share__:') ||
          c.startsWith('__system__:')
        ) {
          return false;
        }
        return c.toLowerCase().includes(q);
      })
      .map((m) => ({ id: m.id, at: m.createdAt.getTime() }));
  }, [messages, searchQuery]);
  const isHidden = hidden.isHidden;
  const serverMatches = useMemo(() => {
    // Only for the text the server actually searched; skip what this user
    // hid or cleared, since those rows never render.
    if (!roomSearch.data || debouncedSearch.trim() !== searchQuery.trim()) return [];
    return roomSearch.data
      .filter((hit) => {
        if (isHidden(hit.id)) return false;
        if (clearedBefore != null && hit.at && hit.at.getTime() < clearedBefore) return false;
        return true;
      })
      .map((hit) => ({ id: hit.id, at: hit.at?.getTime() ?? 0 }));
  }, [roomSearch.data, debouncedSearch, searchQuery, isHidden, clearedBefore]);
  // Union of both, oldest to newest (the order the arrows step through).
  const matchIds = useMemo(() => {
    const atById = new Map<string, number>();
    for (const m of serverMatches) atById.set(m.id, m.at);
    for (const m of localMatches) atById.set(m.id, m.at);
    return [...atById.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id]) => id);
  }, [serverMatches, localMatches]);
  const matchIdSet = useMemo(() => new Set(matchIds), [matchIds]);
  const pickedIndex = pickedMatchId ? matchIds.indexOf(pickedMatchId) : -1;
  const matchIndex = pickedIndex >= 0 ? pickedIndex : Math.max(0, matchIds.length - 1);
  const goToMatch = (index: number) => {
    const clamped = Math.min(Math.max(0, index), matchIds.length - 1);
    setPickedMatchId(matchIds[clamped] ?? null);
  };
  const activeMatchId = searchOpen && matchIds.length > 0 ? (matchIds[matchIndex] ?? null) : null;
  // Scroll the active match into view as the user steps through results. A
  // server hit that is not loaded yet pulls older pages first, the same way
  // a linked message does below (and with the same page cap).
  const matchPagesRef = useRef(0);
  const scrolledMatchRef = useRef<string | null>(null);
  useEffect(() => {
    matchPagesRef.current = 0;
    scrolledMatchRef.current = null;
  }, [activeMatchId]);
  useEffect(() => {
    if (!activeMatchId || scrolledMatchRef.current === activeMatchId) return;
    const el = document.getElementById(`cm-${activeMatchId}`);
    if (el) {
      scrolledMatchRef.current = activeMatchId;
      stickyBottomRef.current = false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (data?.nextCursor && !loadOlder.isPending && matchPagesRef.current < FOCUS_MAX_PAGES) {
      matchPagesRef.current += 1;
      stickyBottomRef.current = false;
      // Rejection already toasted by useLoadOlderMessages' onError.
      void loadOlder.mutateAsync().catch(() => undefined);
    }
  }, [activeMatchId, data, loadOlder]);
  // Jump to a linked message (search result, notification). Loads older
  // pages until the message is on screen, then flashes it briefly.
  const focusPagesRef = useRef(0);
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageId || focusedRef.current === focusMessageId || isLoading) return;
    const el = document.getElementById(`cm-${focusMessageId}`);
    if (el) {
      focusedRef.current = focusMessageId;
      stickyBottomRef.current = false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('ring-2', 'ring-brand-purple/50', 'rounded-md');
      window.setTimeout(
        () => el.classList.remove('ring-2', 'ring-brand-purple/50', 'rounded-md'),
        2_500,
      );
      return;
    }
    if (data?.nextCursor && !loadOlder.isPending && focusPagesRef.current < FOCUS_MAX_PAGES) {
      focusPagesRef.current += 1;
      stickyBottomRef.current = false;
      // Rejection is toasted by useLoadOlderMessages' meta.errorTitle.
      void loadOlder.mutateAsync().catch(() => undefined);
    }
  }, [focusMessageId, data, isLoading, loadOlder]);
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    setPickedMatchId(null);
  };
  const typingNames = useMemo(() => {
    const ids = Object.keys(typing);
    if (ids.length === 0) return '';
    return ids.map((uid) => senderNameById.get(uid) ?? 'Someone').join(', ');
  }, [typing, senderNameById]);

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col',
        fontSizeClass[appearance.fontSize],
        isDark ? 'dark' : '',
      )}
      style={{ backgroundColor: appearance.backgroundColor }}
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        dragCounter.current += 1;
        setDragActive(true);
      }}
      onDragOver={(e) => {
        // preventDefault on dragover is REQUIRED for the drop event to fire.
        if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragCounter.current -= 1;
        if (dragCounter.current <= 0) {
          dragCounter.current = 0;
          setDragActive(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounter.current = 0;
        setDragActive(false);
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) inputRef.current?.addFiles(files);
      }}
    >
      {dragActive ? (
        <div className="border-brand-purple bg-bg-subtle/90 text-ink dark:bg-ink/90 pointer-events-none absolute inset-0 z-30 m-2 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed">
          <Upload className="text-brand-purple h-10 w-10" aria-hidden />
          <span className="text-lg font-semibold">Drag file here</span>
        </div>
      ) : null}
      <header className="border-line dark:bg-ink sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b bg-white px-4 py-2 dark:border-slate-700">
        <div className="flex min-w-0 items-center gap-3">
          {/* Back-to-chat-list button - mobile only. On md+ the sidebar
              is always visible to the left so a back button would be
              redundant. */}
          <Link
            href="/chat"
            aria-label="Back to chat list"
            className="text-ink-muted hover:bg-bg-subtle hover:text-ink grid h-8 w-8 shrink-0 place-items-center rounded-full md:hidden"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Link>
          {isChannel ? (
            <span className="bg-bg-subtle text-ink-muted dark:text-line-strong grid h-8 w-8 shrink-0 place-items-center rounded-full dark:bg-slate-800">
              {room.type === 'VOICE_CHANNEL' ? (
                <Volume2 className="h-4 w-4" aria-hidden />
              ) : (
                <Hash className="h-4 w-4" aria-hidden />
              )}
            </span>
          ) : (
            <UserAvatar size="sm" name={titleName} image={titleImage} />
          )}
          <div className="min-w-0">
            <h2 className="text-ink truncate text-sm font-semibold dark:text-slate-100">
              {isChannel && room.type === 'TEXT_CHANNEL' ? `# ${titleName}` : titleName}
            </h2>
            <p className="text-ink-muted dark:text-ink-disabled truncate text-xs">
              {typingNames ? `${typingNames} typing…` : presenceLabel(room)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Search in conversation"
            onClick={() => setSearchOpen((v) => !v)}
          >
            <Search className="h-4 w-4" />
          </Button>
          {room.type !== 'TEXT_CHANNEL' ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Voice call"
              onClick={() => onStartCall(room.id, peer?.userId)}
            >
              <Phone className="h-4 w-4" />
            </Button>
          ) : null}
          {dmBlock?.ready ? (
            <Button
              size="icon"
              variant="ghost"
              aria-label={dmBlock.blocked ? 'Unblock' : 'Block'}
              title={dmBlock.blocked ? 'Unblock' : 'Block'}
              aria-pressed={dmBlock.blocked}
              disabled={dmBlock.pending}
              onClick={() => (dmBlock.blocked ? dmBlock.unblock() : setConfirmBlock(true))}
              className={dmBlock.blocked ? 'text-state-error' : undefined}
            >
              <Ban className="h-4 w-4" />
            </Button>
          ) : null}
          <Button size="icon" variant="ghost" aria-label="Chat info" onClick={onOpenInfo}>
            <Info className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {searchOpen ? (
        <div className="border-line bg-bg-subtle dark:bg-ink flex shrink-0 items-center gap-2 border-b px-4 py-2 dark:border-slate-700">
          <Search className="text-ink-muted h-4 w-4 shrink-0" aria-hidden />
          <input
            type="search"
            autoFocus
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              // A new query starts at its most recent match.
              setPickedMatchId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              if (e.key === 'Enter' && matchIds.length > 0) {
                e.preventDefault();
                // Enter steps to the previous (older) match, Shift+Enter newer.
                goToMatch(e.shiftKey ? matchIndex + 1 : matchIndex - 1);
              }
            }}
            placeholder="Search this conversation…"
            aria-label="Search this conversation"
            className="border-line h-8 flex-1 rounded-md border bg-white px-3 text-sm dark:bg-slate-900"
          />
          <span className="text-ink-muted shrink-0 text-xs tabular-nums">
            {searchQuery.trim()
              ? matchIds.length > 0
                ? `${matchIndex + 1}/${matchIds.length}`
                : '0/0'
              : ''}
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous (older) match"
            disabled={matchIds.length === 0 || matchIndex <= 0}
            onClick={() => goToMatch(matchIndex - 1)}
            className="h-8 min-h-0 w-8 min-w-0"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next (newer) match"
            disabled={matchIds.length === 0 || matchIndex >= matchIds.length - 1}
            onClick={() => goToMatch(matchIndex + 1)}
            className="h-8 min-h-0 w-8 min-w-0"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close search"
            onClick={closeSearch}
            className="h-8 min-h-0 w-8 min-w-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const t = e.currentTarget;
          stickyBottomRef.current = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
        }}
        className="flex flex-1 flex-col overflow-y-auto px-4 py-3"
      >
        {isLoading ? (
          <div className="m-auto">
            <Loader size="sm" label="Loading messages" />
          </div>
        ) : isError && !data ? (
          <div className="m-auto">
            <QueryError compact message="Couldn't load messages." onRetry={() => void refetch()} />
          </div>
        ) : grouped.length === 0 ? (
          <p className="text-ink-muted dark:text-ink-disabled m-auto text-center text-xs">
            No messages yet. Say hi.
          </p>
        ) : (
          // mt-auto bottom-anchors the conversation: with only a few messages
          // they sit just above the composer (WhatsApp/Slack style) instead of
          // floating at the top; once it overflows, normal scrolling resumes.
          <ul className="mt-auto space-y-2" role="list">
            {data?.nextCursor ? (
              <li className="flex justify-center pb-1">
                <button
                  type="button"
                  onClick={onLoadOlder}
                  disabled={loadOlder.isPending}
                  className="bg-bg-subtle text-ink-muted ring-line hover:bg-line inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ring-1 disabled:opacity-60"
                >
                  {loadOlder.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : null}
                  Load older messages
                </button>
              </li>
            ) : null}
            {grouped.map((g) => (
              <MessageGroup
                key={g.key}
                group={g}
                fromMe={g.senderId === currentUserId}
                showSenderName={room.type !== 'DM'}
                senderName={senderNameById.get(g.senderId) ?? 'Member'}
                selectionMode={selectionMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelected}
                onReply={onReplyMessage}
                onReact={onReactMessage}
                onContextMenu={openMsgMenu}
                onAttachContextMenu={openAttachMenu}
                participantsById={participantsById}
                highlightId={activeMatchId}
                matchIds={matchIdSet}
              />
            ))}
          </ul>
        )}
      </div>

      {selectionMode ? (
        <div className="border-line dark:bg-ink flex shrink-0 items-center justify-between gap-3 border-t bg-white px-4 py-3 dark:border-slate-700">
          <span className="text-ink text-sm font-medium dark:text-slate-100">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={exitSelection}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={selectedIds.size === 0}
              onClick={() => beginForward(Array.from(selectedIds))}
            >
              <Forward className="mr-1.5 h-4 w-4" aria-hidden />
              Forward
            </Button>
          </div>
        </div>
      ) : (
        <ChatInput
          ref={inputRef}
          roomId={room.id}
          currentUserId={currentUserId}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          editing={
            editingMessage ? { id: editingMessage.id, content: editingMessage.content ?? '' } : null
          }
          onClearEdit={() => setEditingMessage(null)}
        />
      )}

      <ContextMenu
        position={msgMenu?.position ?? null}
        items={msgMenuItems}
        ariaLabel="Message actions"
        onClose={() => setMsgMenu(null)}
      />

      <ContextMenu
        position={attachMenu?.position ?? null}
        ariaLabel="Attachment actions"
        onClose={() => setAttachMenu(null)}
        items={
          attachMenu
            ? [
                {
                  id: 'download',
                  label: 'Download',
                  icon: <Download className="h-3.5 w-3.5" aria-hidden />,
                  onSelect: () => downloadUrl(attachMenu.fileUrl, attachMenu.fileName),
                },
                {
                  id: 'open',
                  label: 'Open in new tab',
                  icon: <ExternalLink className="h-3.5 w-3.5" aria-hidden />,
                  onSelect: () => window.open(attachMenu.fileUrl, '_blank', 'noopener,noreferrer'),
                },
                {
                  id: 'copy-link',
                  label: 'Copy link',
                  icon: <Link2 className="h-3.5 w-3.5" aria-hidden />,
                  onSelect: async () => {
                    try {
                      await navigator.clipboard.writeText(attachMenu.fileUrl);
                      toast.success('Link copied.');
                    } catch {
                      toastErrorMessage("Couldn't copy", {
                        description:
                          'Your browser blocked clipboard access. Allow it in site settings, or copy it by hand.',
                      });
                    }
                  },
                },
              ]
            : []
        }
      />

      <ForwardDialog
        open={forwardIds !== null}
        messageIds={forwardIds ?? []}
        currentRoomId={room.id}
        currentUserId={currentUserId}
        isForwarding={forwardMessages.isPending}
        onForward={async (targetRoomIds) => {
          if (!forwardIds || targetRoomIds.length === 0) return;
          // Forward to each selected chat. Sequential keeps the toast/error
          // story simple and avoids hammering the API with parallel writes.
          try {
            for (const targetRoomId of targetRoomIds) {
              await forwardMessages.mutateAsync({ targetRoomId, messageIds: forwardIds });
            }
          } catch {
            // Toasted by useForwardMessages' onError; keep the dialog open to retry.
            return;
          }
          toast.success(
            `Forwarded ${forwardIds.length} message${forwardIds.length === 1 ? '' : 's'} to ${targetRoomIds.length} chat${targetRoomIds.length === 1 ? '' : 's'}.`,
          );
          setForwardIds(null);
          exitSelection();
        }}
        onClose={() => setForwardIds(null)}
      />

      {dmBlock ? (
        <ConfirmDialog
          open={confirmBlock}
          onOpenChange={setConfirmBlock}
          title={`Block ${dmBlock.peer.name || dmBlock.peer.email}?`}
          description="They won't be able to message or call you here, or send you chat requests. They aren't told. You can unblock them in Settings, Communication."
          confirmLabel="Block"
          variant="destructive"
          pending={dmBlock.pending}
          onConfirm={async () => {
            try {
              await dmBlock.block();
              setConfirmBlock(false);
            } catch {
              // Toasted by useBlockChatUser (meta.errorTitle); keep the dialog open.
            }
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Room picker for forwarding selected messages. Lists the user's rooms (the
 * source room first-excluded is allowed - you can forward back into the same
 * room) and forwards on click.
 */
function ForwardDialog({
  open,
  messageIds,
  currentRoomId,
  currentUserId,
  isForwarding,
  onForward,
  onClose,
}: {
  open: boolean;
  messageIds: string[];
  currentRoomId: string;
  currentUserId: string;
  isForwarding: boolean;
  onForward: (targetRoomIds: string[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const { data } = useChatRooms();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Reset the selection + filter each time the dialog opens.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setSearch('');
    }
  }, [open]);

  const filtered = useMemo(() => {
    const all = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      forwardRoomLabel(r, currentRoomId, currentUserId).toLowerCase().includes(q),
    );
  }, [data, search, currentRoomId, currentUserId]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            Forward {messageIds.length} message{messageIds.length === 1 ? '' : 's'}
          </DialogTitle>
        </DialogHeader>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats…"
          aria-label="Search chats"
          className="input h-9 w-full text-sm"
        />

        <ul className="max-h-[45vh] space-y-1 overflow-y-auto" role="list">
          {filtered.length === 0 ? (
            <li className="text-ink-muted py-6 text-center text-xs">
              {search.trim() ? 'No chats match.' : 'No chats to forward to.'}
            </li>
          ) : (
            filtered.map((r) => {
              const checked = selected.has(r.id);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={isForwarding}
                    aria-pressed={checked}
                    onClick={() => toggle(r.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm disabled:opacity-60 dark:text-slate-100',
                      checked
                        ? 'bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20'
                        : 'text-ink hover:bg-bg-subtle',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'grid h-4 w-4 shrink-0 place-items-center rounded border',
                        checked ? 'border-brand-teal bg-brand-teal text-white' : 'border-line',
                      )}
                    >
                      {checked ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="truncate">
                      {forwardRoomLabel(r, currentRoomId, currentUserId)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose} disabled={isForwarding}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isForwarding || selected.size === 0}
            onClick={() => void onForward(Array.from(selected))}
          >
            {isForwarding
              ? 'Forwarding…'
              : `Forward${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function forwardRoomLabel(
  room: ChatRoomSummary,
  currentRoomId: string,
  currentUserId: string,
): string {
  const base = roomTitle(room, currentUserId, { voiceAsChannel: true });
  return room.id === currentRoomId ? `${base} (this chat)` : base;
}

function presenceLabel(room: ChatRoomSummary): string {
  if (room.description && room.description.trim().length > 0) {
    return room.description;
  }
  if (room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL') {
    return room.isPrivate ? 'Private channel' : 'Workspace channel';
  }
  if (room.type === 'GROUP') {
    return `${room.participants.length} members`;
  }
  return 'tap to chat';
}

type MessageKind = 'text' | 'call' | 'share' | 'system';

function messageKind(m: ChatRoomMessage): MessageKind {
  if (parseCallLog(m.content) !== null) return 'call';
  if (parseShareCard(m.content) !== null) return 'share';
  if (parseSystemMessage(m.content) !== null) return 'system';
  return 'text';
}

interface MessageGroupModel {
  key: string;
  senderId: string;
  kind: MessageKind;
  startedAt: Date;
  messages: ChatRoomMessage[];
}

/**
 * Group consecutive messages by the same sender within 5 min, *only when
 * they share the same kind*. Mixing kinds in one group makes the
 * MessageGroup renderer fall through to the generic bubble path and the
 * raw markers (`__call__:`, `__share__:`) leak out. So a call log + a
 * follow-up text from the same person always render as two separate
 * groups now.
 */
function groupBySender(messages: ChatRoomMessage[]): MessageGroupModel[] {
  const out: MessageGroupModel[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    const kind = messageKind(m);
    const within5min =
      last &&
      last.senderId === m.senderId &&
      last.kind === kind &&
      // System-style kinds (call / share) never bundle even with
      // themselves - each gets its own centered row.
      kind === 'text' &&
      m.createdAt.getTime() - last.startedAt.getTime() < 5 * 60 * 1000;
    if (last && within5min) {
      last.messages.push(m);
    } else {
      out.push({
        key: m.id,
        senderId: m.senderId,
        kind,
        startedAt: m.createdAt,
        messages: [m],
      });
    }
  }
  return out;
}

const MessageGroup = memo(function MessageGroup({
  group,
  fromMe,
  showSenderName,
  senderName,
  selectionMode,
  selectedIds,
  onToggleSelect,
  onReply,
  onReact,
  onContextMenu,
  onAttachContextMenu,
  participantsById,
  highlightId,
  matchIds,
}: {
  group: MessageGroupModel;
  fromMe: boolean;
  showSenderName: boolean;
  senderName: string;
  selectionMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onReply: (m: ChatRoomMessage) => void;
  onReact: (messageId: string, emoji: string) => void;
  onContextMenu: (m: ChatRoomMessage, e: React.MouseEvent) => void;
  onAttachContextMenu: (a: { fileUrl: string; fileName: string }, e: React.MouseEvent) => void;
  participantsById: Record<string, string>;
  /** Active in-conversation search match - ringed + scrolled to. */
  highlightId?: string | null;
  /** All current search matches - lightly tinted so they're scannable. */
  matchIds?: Set<string>;
}) {
  // Call-log group → centered system bubbles, no sender label, no reactions.
  if (group.kind === 'call') {
    return (
      <li className="flex flex-col items-center gap-1">
        {group.messages.map((m) => (
          <CallLogBubble key={m.id} message={m} />
        ))}
      </li>
    );
  }
  // Membership-change group → centered gray system rows, like Slack.
  if (group.kind === 'system') {
    return (
      <li className="flex flex-col items-center gap-1">
        {group.messages.map((m) => (
          <SystemMessageBubble key={m.id} message={m} />
        ))}
      </li>
    );
  }
  // Share-card group → render as cards. Different layout footprint than
  // regular bubbles, so the grouper keeps them isolated.
  if (group.kind === 'share') {
    return (
      <li className={cn('flex flex-col gap-1', fromMe ? 'items-end' : 'items-start')}>
        {!fromMe && showSenderName ? (
          <span className="text-brand-gradient px-2 text-[11px] font-medium">{senderName}</span>
        ) : null}
        {group.messages.map((m) => (
          <ShareCardBubble
            key={m.id}
            message={m}
            fromMe={fromMe}
            onContextMenu={(e) => onContextMenu(m, e)}
          />
        ))}
      </li>
    );
  }
  // Mirror the sender-name pill on own messages too. Previously only
  // others got a name on top, which left the user's own bubbles floating
  // anonymously. Showing the name on both sides keeps the column visually
  // balanced and matches the user's expectation of "my name on top".
  return (
    <li className={cn('flex flex-col gap-0.5', fromMe ? 'items-end' : 'items-start')}>
      {showSenderName ? (
        <span
          className={cn(
            'px-2 text-[11px] font-medium',
            fromMe ? 'text-brand-purple' : 'text-brand-teal dark:text-emerald-400',
          )}
        >
          {fromMe ? 'You' : senderName}
        </span>
      ) : null}
      {group.messages.map((m) => (
        <MessageBubble
          key={m.id}
          message={m}
          fromMe={fromMe}
          selectionMode={selectionMode}
          selected={selectedIds.has(m.id)}
          onToggleSelect={onToggleSelect}
          onReply={onReply}
          onReact={onReact}
          onContextMenu={onContextMenu}
          onAttachContextMenu={onAttachContextMenu}
          participantsById={participantsById}
          highlighted={highlightId === m.id}
          matched={matchIds?.has(m.id) ?? false}
        />
      ))}
    </li>
  );
});

function CallLogBubble({ message }: { message: ChatRoomMessage }) {
  const log = parseCallLog(message.content);
  if (!log) return null;
  const Icon = log.status === 'MISSED' ? PhoneMissed : Phone;
  const tone =
    log.status === 'MISSED'
      ? 'border-state-error/30 bg-tint-error text-state-error'
      : 'border-line bg-white text-ink';
  const label =
    log.status === 'COMPLETED'
      ? `Call ended · ${formatCallDuration(log.durationSec)}`
      : log.status === 'MISSED'
        ? 'Missed call'
        : 'Call declined';
  return (
    <div
      className={cn(
        'flex max-w-[78%] items-center gap-2 rounded-full border px-3 py-1 text-xs shadow-sm',
        tone,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      <span className="font-medium">{label}</span>
      <span className="text-ink-muted text-[10px]" title={absoluteTime(message.createdAt)}>
        · {relativeTime(message.createdAt)}
      </span>
    </div>
  );
}

function SystemMessageBubble({ message }: { message: ChatRoomMessage }) {
  const parsed = parseSystemMessage(message.content);
  if (!parsed) return null;
  return (
    <div className="bg-bg-subtle text-ink-muted flex max-w-[80%] items-center gap-1.5 rounded-full px-3 py-1 text-[11px]">
      <span className="font-medium">{formatSystemMessage(parsed)}</span>
      <span className="text-[10px]" title={absoluteTime(message.createdAt)}>
        · {relativeTime(message.createdAt)}
      </span>
    </div>
  );
}

function ShareCardBubble({
  message,
  fromMe,
  onContextMenu,
}: {
  message: ChatRoomMessage;
  fromMe: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const card = parseShareCard(message.content);
  if (!card) return null;
  const kindLabel =
    card.itemType === 'task'
      ? 'Task'
      : card.itemType === 'timesheet'
        ? 'Time entry'
        : card.itemType === 'todo'
          ? 'Todo'
          : 'Email';
  return (
    <a
      href={card.link}
      onContextMenu={onContextMenu}
      className={cn(
        'block max-w-[78%] rounded-xl border px-3 py-2 shadow-sm transition-colors',
        fromMe
          ? 'border-brand-purple/20 bg-bg-subtle hover:bg-bg-app'
          : 'border-line hover:bg-bg-subtle bg-white',
      )}
    >
      <div className="text-ink-muted text-[10px] font-semibold uppercase tracking-wide">
        {kindLabel}
      </div>
      <div className="text-ink mt-0.5 line-clamp-2 text-sm font-medium">{card.title}</div>
      {card.subtitle ? (
        <div className="text-ink-muted mt-0.5 truncate text-xs">{card.subtitle}</div>
      ) : null}
      <div className="text-ink-disabled mt-1 text-[10px]" title={absoluteTime(message.createdAt)}>
        {relativeTime(message.createdAt)}
      </div>
    </a>
  );
}

function formatCallDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

// Memoized: callbacks take the message as an argument (instead of per-row
// closures) so a bubble only re-renders when its own message, selection or
// search-highlight state changes.
const MessageBubble = memo(function MessageBubble({
  message,
  fromMe,
  selectionMode,
  selected,
  onToggleSelect: onToggleSelectId,
  onReply: onReplyMessage,
  onReact: onReactMessage,
  onContextMenu: onMessageContextMenu,
  onAttachContextMenu,
  participantsById,
  highlighted,
  matched,
}: {
  message: ChatRoomMessage;
  fromMe: boolean;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onReply: (m: ChatRoomMessage) => void;
  onReact: (messageId: string, emoji: string) => void;
  onContextMenu: (m: ChatRoomMessage, e: React.MouseEvent) => void;
  onAttachContextMenu: (a: { fileUrl: string; fileName: string }, e: React.MouseEvent) => void;
  participantsById: Record<string, string>;
  /** Active in-conversation search match. */
  highlighted: boolean;
  /** One of the current search matches. */
  matched: boolean;
}) {
  const onToggleSelect = () => onToggleSelectId(message.id);
  const onReply = () => onReplyMessage(message);
  const onReact = (emoji: string) => onReactMessage(message.id, emoji);
  const onContextMenu = (e: React.MouseEvent) => onMessageContextMenu(message, e);
  const [showPicker, setShowPicker] = useState(false);
  const qc = useQueryClient();
  const isTmp = message.id.startsWith('tmp:');
  const isDeleted = !!message.deletedAt;
  // Optimistic attachment messages carry a transient `__uploading` flag while
  // their files are being uploaded; we overlay a loader + cancel on them.
  const isUploading =
    isTmp && Boolean((message as ChatRoomMessage & { __uploading?: boolean }).__uploading);
  const cancelUpload = () => {
    abortChatAttachmentUpload(message.id);
    removeRoomMessage(qc, message.roomId, message.id);
  };
  return (
    <div
      id={`cm-${message.id}`}
      onContextMenu={onContextMenu}
      onClick={selectionMode ? onToggleSelect : undefined}
      className={cn(
        // `max-w-[min(78%,560px)]` lives on this OUTER wrapper, not on the
        // inner bubble, because this wrapper is the direct flex item of
        // the `<li>` flex column. Percentages on flex items resolve
        // against the flex container's cross-axis (the full row width),
        // so 78% is meaningful here. Previously the constraint was on
        // the inner `inline-block` div, whose parent (this wrapper) had
        // intrinsic width, making 78% resolve against the bubble's own
        // content width and squashing short messages like "normal" into
        // a 40px column. `w-fit` keeps the wrapper shrink-to-content
        // when the message is shorter than the cap. (Keep the id + search
        // highlight on THIS element too - an extra wrapper div here breaks
        // the percentage max-width and squashes fixed-width bubbles like the
        // voice player.)
        'group/bubble relative w-fit max-w-[min(78%,560px)]',
        fromMe ? 'self-end' : 'self-start',
        selectionMode ? 'cursor-pointer rounded-xl ring-2 ring-offset-1' : '',
        selectionMode ? (selected ? 'ring-brand-purple' : 'ring-transparent') : '',
        // In-conversation search highlight (only when not selecting).
        !selectionMode && highlighted
          ? 'ring-brand-purple/70 rounded-xl ring-2'
          : !selectionMode && matched
            ? 'ring-brand-purple/30 rounded-xl ring-1'
            : '',
      )}
    >
      {!isTmp && !isDeleted && !selectionMode ? (
        <div
          className={cn(
            'absolute top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/bubble:opacity-100',
            fromMe ? 'right-full mr-1' : 'left-full ml-1',
          )}
        >
          <button
            type="button"
            onClick={() => setShowPicker((v) => !v)}
            aria-label="Add reaction"
            className="text-ink-muted hover:bg-bg-subtle grid h-7 w-7 place-items-center rounded-full bg-white shadow ring-1 ring-slate-200"
          >
            <Smile className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onReply}
            aria-label="Reply"
            className="text-ink-muted hover:bg-bg-subtle grid h-7 w-7 place-items-center rounded-full bg-white shadow ring-1 ring-slate-200"
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {showPicker ? (
        <div
          className={cn(
            'border-line absolute bottom-full mb-1 flex gap-1 rounded-full border bg-white p-1 shadow-lg',
            fromMe ? 'right-0' : 'left-0',
          )}
        >
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => {
                onReact(emoji);
                setShowPicker(false);
              }}
              className="hover:bg-bg-subtle grid h-7 w-7 place-items-center rounded-full text-sm"
              aria-label={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          // `block` instead of `inline-block` so the bubble fills the
          // outer wrapper's width (now constrained by max-w there).
          // Removing the local max-w-[78%] avoids the prior
          // intrinsic-parent percentage trap.
          'chat-bubble-content shadow-soft block rounded-xl px-3.5 py-2 text-sm',
          isTmp ? 'opacity-70' : '',
          isDeleted ? 'italic opacity-70' : '',
          fromMe
            ? 'bg-bg-subtle text-ink ring-brand-purple/15 rounded-br-[4px] ring-1'
            : 'text-ink ring-line rounded-bl-[4px] bg-white ring-1',
        )}
      >
        {!isDeleted && message.parentMessage ? (
          <ReplyPreview parent={message.parentMessage} participantsById={participantsById} />
        ) : null}
        {isDeleted ? (
          <span className="text-ink-muted">This message was deleted.</span>
        ) : message.content ? (
          <span className="whitespace-pre-wrap break-words [&_a]:underline">
            <ChatMarkdown text={message.content} />
          </span>
        ) : null}
        {!isDeleted && message.attachments.length > 0 ? (
          <ul className="mt-2 space-y-2" role="list">
            {message.attachments.map((a) => {
              // Three attachment shapes:
              //   - image/*  → inline preview, click to open full-size in a
              //                new tab. Matches WhatsApp / Slack expectation.
              //   - audio/*  → native player with scrub controls.
              //   - other    → filename link with download chip.
              const isAudio = a.fileType.startsWith('audio/');
              const isImage = a.fileType.startsWith('image/');
              return (
                <li key={a.id} className="relative">
                  {isImage ? (
                    <a
                      href={a.fileUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onContextMenu={(e) =>
                        onAttachContextMenu({ fileUrl: a.fileUrl, fileName: a.fileName }, e)
                      }
                      className="ring-line hover:shadow-soft block overflow-hidden rounded-lg ring-1 transition-shadow"
                      aria-label={`Image: ${a.fileName}`}
                    >
                      {/* Width cap matches the bubble's max-w; height
                          capped so a tall portrait image doesn't blow
                          the bubble out vertically. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={a.fileUrl}
                        alt={a.fileName}
                        loading="lazy"
                        className="block max-h-72 w-auto max-w-full object-cover"
                      />
                    </a>
                  ) : isAudio ? (
                    <VoiceMessage src={a.fileUrl} fileName={a.fileName} fromMe={fromMe} />
                  ) : (
                    <FileAttachmentChip
                      fileUrl={a.fileUrl}
                      fileName={a.fileName}
                      fileType={a.fileType}
                      onContextMenu={(e) =>
                        onAttachContextMenu({ fileUrl: a.fileUrl, fileName: a.fileName }, e)
                      }
                    />
                  )}
                  {isUploading ? (
                    <>
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-black/40">
                        <Loader2 className="h-6 w-6 animate-spin text-white" />
                      </div>
                      <button
                        type="button"
                        onClick={cancelUpload}
                        aria-label="Cancel upload"
                        className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/70 text-white hover:bg-black/80"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="text-ink-muted mt-0.5 flex items-center justify-end gap-1 text-[10px]">
          {!isDeleted && message.editedAt ? (
            <span title={`Edited ${absoluteTime(message.editedAt)}`}>edited</span>
          ) : null}
          <span title={absoluteTime(message.createdAt)}>{relativeTime(message.createdAt)}</span>
          {fromMe && !isDeleted ? <StatusTick status={message.status} /> : null}
        </div>
      </div>

      {!isDeleted && message.reactions.length > 0 ? (
        <div className={cn('mt-1 flex flex-wrap gap-1', fromMe ? 'justify-end' : 'justify-start')}>
          {message.reactions.map((r) => (
            <button
              key={r.emoji}
              type="button"
              onClick={() => onReact(r.emoji)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ring-1 transition-colors',
                r.reactedByMe
                  ? 'bg-brand-gradient text-white ring-transparent'
                  : 'text-ink ring-line hover:bg-bg-subtle bg-white',
              )}
            >
              <span>{r.emoji}</span>
              <span className="font-medium">{r.count}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

function ReplyPreview({
  parent,
  participantsById,
}: {
  parent: NonNullable<ChatRoomMessage['parentMessage']>;
  participantsById: Record<string, string>;
}) {
  const senderName = participantsById[parent.senderId] ?? 'Member';
  return (
    <div className="border-brand-purple bg-bg-subtle text-ink mb-1 rounded-md border-l-2 px-2 py-1 text-xs">
      <div className="text-brand-gradient font-medium">{senderName}</div>
      <div className="text-ink-muted line-clamp-2">
        {parent.deletedAt ? '(message deleted)' : (parent.content ?? '(no content)')}
      </div>
    </div>
  );
}

// URL auto-linking + inline markdown rendering moved to chat-markdown.tsx
// (ChatMarkdown), which both linkifies bare URLs and renders **bold** / *italic*
// / ~strike~ / `code` / ```code blocks``` / [label](url) / bullet lines.

function StatusTick({ status }: { status: ChatRoomMessage['status'] }) {
  if (status === 'READ') {
    return <CheckCheck className="text-brand-teal h-3.5 w-3.5" aria-label="Read" />;
  }
  if (status === 'DELIVERED') {
    return <CheckCheck className="text-ink-disabled h-3.5 w-3.5" aria-label="Delivered" />;
  }
  return <Check className="text-ink-disabled h-3.5 w-3.5" aria-label="Sent" />;
}

/**
 * A non-image, non-audio attachment shown as a downloadable chip. Files are
 * served by the API with `Content-Disposition: attachment` for anything
 * that isn't a safe raster image, so opening one downloads it rather than
 * rendering it in our origin. On top of that, for genuinely risky types
 * (executables, HTML, SVG, scripts) we interrupt with a "this file may be
 * harmful" warning - matching the WhatsApp download-warning behaviour - so a
 * user can't one-click open something dangerous a peer sent.
 */
function FileAttachmentChip({
  fileUrl,
  fileName,
  fileType,
  onContextMenu,
}: {
  fileUrl: string;
  fileName: string;
  fileType: string;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const risky = isRiskyFile(fileName, fileType);
  const [warnOpen, setWarnOpen] = useState(false);

  if (!risky) {
    return (
      <a
        href={fileUrl}
        target="_blank"
        rel="noopener noreferrer"
        onContextMenu={onContextMenu}
        className="bg-bg-subtle text-ink hover:bg-line inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs"
      >
        📎 <span className="max-w-[200px] truncate">{fileName}</span>
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setWarnOpen(true)}
        onContextMenu={onContextMenu}
        className="bg-bg-subtle text-ink ring-state-error/30 hover:bg-line inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ring-1"
      >
        <span aria-hidden>⚠️</span>
        <span className="max-w-[200px] truncate">{fileName}</span>
      </button>
      <ConfirmDialog
        open={warnOpen}
        onOpenChange={setWarnOpen}
        title="This file may be harmful"
        description={`"${fileName}" is a type of file that can contain viruses or run scripts (for example an executable, HTML, SVG, or script file). Only open it if you trust the sender. Download anyway?`}
        confirmLabel="Download anyway"
        variant="destructive"
        onConfirm={() => {
          window.open(fileUrl, '_blank', 'noopener,noreferrer');
          setWarnOpen(false);
        }}
      />
    </>
  );
}
