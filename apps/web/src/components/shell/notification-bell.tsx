'use client';

import {
  Bell,
  BellRing,
  CheckCheck,
  CheckSquare,
  MessageSquare,
  PhoneMissed,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

import { UserAvatar } from '@/components/ui/avatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useInAppNotifications } from '@/hooks/use-in-app-notifications';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/hooks/use-notifications';
import { getChatNotifications } from '@/lib/chat-prefs';
import { playMessageBlip } from '@/lib/chat-sounds';
import {
  clearAllInAppNotifications,
  clearInAppNotifications,
  markAllInAppRead,
  markInAppRead,
  type InAppNotification,
} from '@/lib/in-app-notifications';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * Unified notification bell. Surfaces every kind of activity in one place:
 *
 *   - Server-side rows (task assigned, comment) from the notifications API.
 *   - Client-mirrored rows (chat messages, missed calls) the `GlobalRealtime`
 *     dispatcher pushes into `lib/in-app-notifications` whenever an event
 *     fires on the chat socket.
 *
 * Bell affordances:
 *   - Click an item → marks it read and follows its deep link.
 *   - "Mark all read" → clears unread badges for both feeds.
 *   - "Select" toggle → multi-select with per-row checkboxes; the action
 *     bar offers Clear selected / Clear all. Cleared items are removed
 *     from the in-app mirror (the server-side rows still live on the API
 *     until the user marks them read - clearing those would need a
 *     `delete` endpoint we don't ship yet, so the UI hides them locally).
 */
export function NotificationBell({
  variant = 'default',
}: {
  /** `rail` renders the trigger for the dark icon rail and opens the panel
   *  beside it instead of below it. */
  variant?: 'default' | 'rail';
} = {}) {
  const [open, setOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Server-side rows the user chose to hide locally - see the comment in
  // the action bar handler below.
  const [hiddenServerIds, setHiddenServerIds] = useState<Set<string>>(new Set());

  const { data, refetch } = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const inApp = useInAppNotifications();

  /** Merge server-task feed + client chat/call feed into a sorted list. */
  const merged = useMemo(() => {
    const serverItems = (data?.items ?? [])
      .filter((n) => !hiddenServerIds.has(n.id))
      .map<UnifiedRow>((n) => ({
        id: `srv:${n.id}`,
        rawId: n.id,
        source: 'server',
        kind: n.type === 'TASK_COMMENT' ? 'comment' : 'task',
        title: n.title,
        body: n.body,
        // Prefer the explicit deep-link (set for all the cross-app
        // notification types); fall back to the task link, then dashboard.
        url: n.url ?? (n.taskId ? `/tasks/${n.taskId}` : '/dashboard'),
        createdAt: n.createdAt.getTime(),
        readAt: n.readAt ? n.readAt.getTime() : null,
        actorImage: n.actor?.image ?? null,
        actorName: n.actor?.name ?? null,
      }));
    const clientItems = inApp.map<UnifiedRow>((n) => ({
      id: `cli:${n.id}`,
      rawId: n.id,
      source: 'client',
      kind: n.kind,
      title: n.title,
      body: n.body,
      url: n.url,
      createdAt: n.createdAt,
      readAt: n.readAt,
      actorImage: n.actorImage,
      actorName: n.actorName,
    }));
    return [...serverItems, ...clientItems]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50);
  }, [data, inApp, hiddenServerIds]);

  const unreadCount = useMemo(
    () => merged.filter((n) => !n.readAt).length,
    [merged],
  );
  const Icon = unreadCount > 0 ? BellRing : Bell;

  // Play a soft blip whenever the unread total ticks up. Skip first paint
  // so a fresh page load doesn't ding on the existing backlog.
  const previousUnread = useRef<number | null>(null);
  useEffect(() => {
    // The rail layout mounts two bells (desktop rail and mobile header, one
    // hidden by CSS). Only the default bell chimes, so a notification is
    // heard once.
    if (variant === 'rail') return;
    const prev = previousUnread.current;
    previousUnread.current = unreadCount;
    if (prev === null) return;
    if (unreadCount <= prev) return;
    const prefs = getChatNotifications();
    if (prefs.doNotDisturb) return;
    if (!prefs.messageSound) return;
    playMessageBlip(prefs.volume);
  }, [unreadCount, variant]);

  function toggleSelected(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRowClick(row: UnifiedRow): void {
    if (selectMode) {
      toggleSelected(row.id);
      return;
    }
    if (!row.readAt) {
      if (row.source === 'server') markRead.mutate(row.rawId);
      else markInAppRead([row.rawId]);
    }
  }

  function handleMarkAllRead(): void {
    markAllRead.mutate();
    markAllInAppRead();
  }

  function handleClearSelected(): void {
    const clientIds: string[] = [];
    const serverIds: string[] = [];
    for (const row of merged) {
      if (!selected.has(row.id)) continue;
      if (row.source === 'client') clientIds.push(row.rawId);
      else serverIds.push(row.rawId);
    }
    if (clientIds.length > 0) clearInAppNotifications(clientIds);
    // The server feed doesn't ship a delete endpoint yet, so we mark them
    // read (so the unread badge clears) AND hide locally. The next session
    // load re-fetches the API; the hidden set lives in component state on
    // purpose so a refresh brings them back into history.
    for (const id of serverIds) {
      markRead.mutate(id);
    }
    if (serverIds.length > 0) {
      setHiddenServerIds((prev) => {
        const next = new Set(prev);
        for (const id of serverIds) next.add(id);
        return next;
      });
    }
    setSelected(new Set());
    setSelectMode(false);
  }

  function handleClearAll(): void {
    clearAllInAppNotifications();
    // Single batched mutation rather than N per-row calls - the server
    // endpoint flips every unread row for the current user in one
    // statement, so calling per-id was wasteful + chatty on the network.
    const hasUnreadServer = merged.some((r) => r.source === 'server' && !r.readAt);
    if (hasUnreadServer) markAllRead.mutate();
    setHiddenServerIds((prev) => {
      const next = new Set(prev);
      for (const row of merged) {
        if (row.source === 'server') next.add(row.rawId);
      }
      return next;
    });
    setSelected(new Set());
    setSelectMode(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void refetch();
        else {
          setSelectMode(false);
          setSelected(new Set());
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            unreadCount > 0
              ? `Notifications, ${unreadCount} unread`
              : 'Notifications'
          }
          title="Notifications"
          className={
            variant === 'rail'
              ? 'relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[#8A919D] transition-colors hover:bg-white/[0.07] hover:text-[#C9CDD6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
              : 'relative grid h-9 w-9 place-items-center rounded-full text-ink-muted transition-all hover:bg-bg-surface hover:text-ink hover:shadow-soft focus-visible:outline-none focus-visible:shadow-focus'
          }
        >
          <Icon className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className={
                variant === 'rail'
                  ? // The rail button is 32px: hang the badge off the corner so
                    // it never covers the bell itself.
                    'absolute -right-1.5 -top-1 inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-lg bg-[#FF4D3D] px-1 text-[9px] font-bold text-white'
                  : 'absolute right-0.5 top-0.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-brand-gradient px-1 text-[10px] font-semibold text-white shadow-sm'
              }
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={variant === 'rail' ? 'right' : 'bottom'}
        className="w-[min(380px,calc(100vw-1.5rem))] p-0"
      >
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <span className="text-sm font-semibold text-ink">Notifications</span>
          <div className="flex items-center gap-2">
            {merged.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setSelectMode((s) => !s);
                  setSelected(new Set());
                }}
                className="rounded px-2 py-1 text-[11px] font-medium text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
              >
                {selectMode ? 'Cancel' : 'Select'}
              </button>
            ) : null}
            {unreadCount > 0 && !selectMode ? (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-brand-gradient font-medium hover:underline focus-visible:outline-none focus-visible:shadow-focus"
              >
                <CheckCheck className="h-3.5 w-3.5 text-brand-purple" />
                Mark all read
              </button>
            ) : null}
          </div>
        </header>

        {selectMode ? (
          <div className="flex items-center justify-between gap-2 border-b border-line bg-bg-subtle px-4 py-2 text-xs text-ink-muted">
            <span>
              {selected.size > 0
                ? `${selected.size} selected`
                : 'Tap rows to select'}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={selected.size === 0}
                onClick={handleClearSelected}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-state-error hover:bg-tint-error disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear selected
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-ink-muted hover:bg-bg-app hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
                Clear all
              </button>
            </div>
          </div>
        ) : null}

        <ul className="max-h-96 divide-y divide-line overflow-y-auto" role="list">
          {merged.length === 0 ? (
            <li className="px-4 py-10 text-center text-xs text-ink-muted">
              You&rsquo;re all caught up.
            </li>
          ) : (
            merged.map((n) => (
              <li key={n.id}>
                <NotificationRow
                  row={n}
                  selectMode={selectMode}
                  selected={selected.has(n.id)}
                  onClick={() => handleRowClick(n)}
                />
              </li>
            ))
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

interface UnifiedRow {
  id: string;
  rawId: string;
  source: 'server' | 'client';
  kind: 'task' | 'comment' | InAppNotification['kind'];
  title: string;
  body: string;
  url: string;
  createdAt: number;
  readAt: number | null;
  actorImage: string | null;
  actorName: string | null;
}

interface RowProps {
  row: UnifiedRow;
  selectMode: boolean;
  selected: boolean;
  onClick: () => void;
}

function NotificationRow({ row, selectMode, selected, onClick }: RowProps) {
  const unread = !row.readAt;

  // Pick an icon that matches the kind so the user can scan the list
  // visually - task = check, message = bubble, missed call = phone.
  const KindIcon = (() => {
    switch (row.kind) {
      case 'chat':
        return MessageSquare;
      case 'call-missed':
        return PhoneMissed;
      case 'task':
      case 'comment':
      default:
        return CheckSquare;
    }
  })();

  const inner = (
    <div className="flex w-full items-start gap-3 px-4 py-3 text-left">
      {selectMode ? (
        <span
          aria-hidden
          className={cn(
            'mt-1 grid h-4 w-4 shrink-0 place-items-center rounded border',
            selected
              ? 'border-brand-purple bg-brand-gradient text-white'
              : 'border-line-strong bg-bg-surface text-transparent',
          )}
        >
          {selected ? <CheckSquare className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </span>
      ) : null}
      {row.actorName ? (
        <UserAvatar size="sm" name={row.actorName} image={row.actorImage} />
      ) : (
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg-subtle text-ink-muted">
          <KindIcon className="h-3.5 w-3.5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', unread ? 'font-semibold text-ink' : 'text-ink')}>
          {row.title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{row.body}</p>
        <p className="mt-1 text-[11px] text-ink-disabled">
          {relativeTime(new Date(row.createdAt))}
        </p>
      </div>
    </div>
  );

  const containerClass = cn(
    'relative flex w-full items-stretch transition-colors',
    unread ? 'bg-brand-gradient-soft hover:bg-bg-subtle' : 'hover:bg-bg-subtle',
    selected ? 'bg-brand-gradient-soft' : '',
  );

  if (selectMode) {
    // In select mode rows act as toggles, not links - never navigate.
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(containerClass, 'text-left focus-visible:outline-none focus-visible:bg-bg-subtle')}
      >
        {unread ? (
          <span
            aria-hidden
            className="absolute left-0 top-0 h-full w-[3px] bg-brand-gradient"
          />
        ) : null}
        {inner}
      </button>
    );
  }

  return (
    <Link
      href={row.url}
      onClick={onClick}
      className={cn(containerClass, 'focus-visible:outline-none focus-visible:bg-bg-subtle')}
    >
      {unread ? (
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-[3px] bg-brand-gradient"
        />
      ) : null}
      {inner}
    </Link>
  );
}
