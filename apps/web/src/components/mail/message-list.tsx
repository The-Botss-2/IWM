'use client';

import {
  Archive,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Inbox,
  Mail as MailIcon,
  MailOpen,
  Paperclip,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MailFolder, MailMessageListItem } from '@botss/shared-types';

import { ShareToChatDialog } from '@/components/chat/share-to-chat-dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ContextMenu, type ContextMenuItem } from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useDebouncedValue } from '@/hooks/use-debounced';
import {
  useBulkDeleteMessages,
  useBulkFlagMessages,
  useBulkMoveMessages,
  useEmptyFolder,
  useFlagMessage,
  useMailMessages,
  useMarkFolderAllRead,
  useResyncMailFolder,
  useSyncMailAccount,
} from '@/hooks/use-mail';
import { cn } from '@/lib/utils';
import { relativeTime } from '@/lib/time';

interface Props {
  accountId: string;
  folderId: string | null;
  folder?: MailFolder | null;
  selectedMessageId: string | null;
  onSelect: (id: string) => void;
  /** Fired after a bulk move/delete affects the currently-open message so the
   *  parent can clear the reader pane. */
  onAfterBulkAction?: (affectedIds: string[]) => void;
  /** Close (deselect) the currently-open message. Wired to the row
   *  right-click menu's "Close" item, mirroring closing an open chat. */
  onClose?: () => void;
}

/**
 * Middle pane of the mail UI. Server-side search across the configured
 * folder; client-side toggles for unread + starred filters. Multi-select
 * mode lets the user act on a batch - Archive / Spam / Trash / Inbox,
 * Mark read/unread, or Permanently delete (Trash/Spam source folders only).
 * No virtualization yet - the page size cap of 50 is enough for snappy
 * rendering. Adding @tanstack/react-virtual lands when folder counts
 * routinely exceed a few hundred visible rows.
 */
export function MessageList({
  accountId,
  folderId,
  folder,
  selectedMessageId,
  onSelect,
  onAfterBulkAction,
  onClose,
}: Props) {
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [starredOnly, setStarredOnly] = useState(false);
  // Gmail-style paging: 50 per page, navigated by cursor. `pageCursors[i]` is
  // the cursor that fetches page i (page 0 uses none). We remember each page's
  // cursor as the user advances so "Newer" steps back instantly without a
  // re-derivation, and the scroll resets to the top on every page change.
  const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmResync, setConfirmResync] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [shareTarget, setShareTarget] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const markAllRead = useMarkFolderAllRead();
  const emptyFolder = useEmptyFolder();
  const resyncFolder = useResyncMailFolder();
  const syncAccount = useSyncMailAccount();
  // Mirror the server-side 5 s manual-sync debounce in the UI so a mashed
  // refresh button doesn't fire redundant requests that the API would just
  // no-op. The button stays disabled (and the icon keeps spinning) until the
  // window elapses.
  const [refreshCoolingDown, setRefreshCoolingDown] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const handleRefresh = useCallback(() => {
    if (syncAccount.isPending || refreshCoolingDown) return;
    syncAccount.mutate(accountId);
    setRefreshCoolingDown(true);
    refreshTimer.current = setTimeout(() => setRefreshCoolingDown(false), 5_000);
  }, [syncAccount, refreshCoolingDown, accountId]);
  const refreshing = syncAccount.isPending || refreshCoolingDown;
  const bulkMove = useBulkMoveMessages();
  const bulkFlag = useBulkFlagMessages();
  const bulkDelete = useBulkDeleteMessages();
  const isTrash = folder?.role === 'TRASH';
  const isSpam = folder?.role === 'SPAM';
  const isTrashOrSpam = isTrash || isSpam;

  // Stable query identity so TanStack Query's deep-equal key check is cheap
  // and the cache row reuses across unrelated state changes (selection,
  // confirm dialog toggle).
  const cursor = pageCursors[pageIndex];
  const query = useMemo(
    () => ({
      accountId,
      ...(folderId ? { folderId } : {}),
      ...(debouncedSearch.trim() ? { search: debouncedSearch.trim() } : {}),
      ...(unreadOnly ? { unreadOnly: true } : {}),
      ...(starredOnly ? { starredOnly: true } : {}),
      ...(cursor ? { cursor } : {}),
      limit: 50,
    }),
    [accountId, folderId, debouncedSearch, unreadOnly, starredOnly, cursor],
  );

  const { data, isLoading, isError, refetch } = useMailMessages(query);
  const flag = useFlagMessage();

  // Memoised so the `items` reference is stable across renders that
  // don't actually change the data. Without this, the inline
  // `data?.items ?? []` expression produces a NEW `[]` every render
  // when data is undefined, which would re-run any downstream
  // `useMemo` / `useCallback` whose dep array contains `items` -
  // ESLint flagged that on lines 111 and 153.
  const items = useMemo(() => data?.items ?? [], [data?.items]);

  // Drop selection when the user changes folders, accounts, or filters out
  // every previously-checked row. Without this, switching folders would
  // leave the bulk bar showing a count that no longer maps to any visible
  // row, and the bulk-action endpoint would receive ids the user can no
  // longer see.
  const itemIds = useMemo(() => items.map((m) => m.id), [items]);
  useEffect(() => {
    setSelectedIds(new Set());
  }, [accountId, folderId]);
  // Reset to the first page whenever the underlying result set changes
  // (folder, account, search, or filters) - otherwise switching folders could
  // leave you stranded on "page 3" of a set that no longer has one.
  useEffect(() => {
    setPageCursors([undefined]);
    setPageIndex(0);
  }, [accountId, folderId, debouncedSearch, unreadOnly, starredOnly]);
  useEffect(() => {
    // Prune any selected ids that fell out of the visible list (search
    // filter changed, server expunged the row, etc). Skip the work when
    // the selection is empty.
    if (selectedIds.size === 0) return;
    const visible = new Set(itemIds);
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemIds]);

  const selectionCount = selectedIds.size;
  const hasSelection = selectionCount > 0;
  const allVisibleSelected =
    items.length > 0 && items.every((m) => selectedIds.has(m.id));
  const someVisibleSelected = hasSelection && !allVisibleSelected;
  const selectionIds = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const bulkPending = bulkMove.isPending || bulkDelete.isPending || bulkFlag.isPending;

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Gmail-style page navigation. "Older" advances using the server's
  // nextCursor (only enabled when one exists); "Newer" steps back through the
  // remembered cursors. Both clear the selection and scroll to the top.
  const hasNextPage = !!data?.nextCursor;
  const goNewer = useCallback(() => {
    setPageIndex((i) => Math.max(0, i - 1));
    setSelectedIds(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);
  const goOlder = useCallback(() => {
    const next = data?.nextCursor;
    if (!next) return;
    setPageCursors((prev) => {
      const copy = [...prev];
      copy[pageIndex + 1] = next;
      return copy;
    });
    setPageIndex((i) => i + 1);
    setSelectedIds(new Set());
    scrollRef.current?.scrollTo({ top: 0 });
  }, [data?.nextCursor, pageIndex]);

  // 1-based range for the footer label, e.g. "51-100".
  const rangeStart = items.length > 0 ? pageIndex * 50 + 1 : 0;
  const rangeEnd = pageIndex * 50 + items.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      if (items.length > 0 && items.every((m) => prev.has(m.id))) {
        // All currently visible rows are selected - clear them all.
        const next = new Set(prev);
        for (const m of items) next.delete(m.id);
        return next;
      }
      const next = new Set(prev);
      for (const m of items) next.add(m.id);
      return next;
    });
  }, [items]);

  const handleToggleOne = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Stable callbacks let the memoized MessageRow skip re-renders when
  // unrelated list-level state changes (search debounce tick, filter
  // toggle, mark-all-read mutation). Without these, every row diffs prop
  // identity and re-renders.
  const handleSelectRow = useCallback(
    (id: string) => {
      onSelect(id);
    },
    [onSelect],
  );
  const handleToggleStar = useCallback(
    (id: string, isStarred: boolean) => {
      flag.mutate({ id, op: isStarred ? 'unstar' : 'star' });
    },
    [flag],
  );
  const handleShare = useCallback((id: string, label: string) => {
    setShareTarget({ id, label });
  }, []);

  // Right-click menu on a row, mirroring chat's right-click-to-close. Holds
  // the targeted message plus the click position; null when hidden.
  const [rowMenu, setRowMenu] = useState<{
    message: MailMessageListItem;
    position: { x: number; y: number };
  } | null>(null);
  const handleRowContextMenu = useCallback(
    (message: MailMessageListItem, e: React.MouseEvent) => {
      e.preventDefault();
      setRowMenu({ message, position: { x: e.clientX, y: e.clientY } });
    },
    [],
  );
  const rowMenuItems = useMemo<ContextMenuItem[]>(() => {
    const m = rowMenu?.message;
    if (!m) return [];
    return [
      {
        id: 'open',
        label: 'Open',
        icon: <MailOpen className="h-3.5 w-3.5" aria-hidden />,
        onSelect: () => onSelect(m.id),
      },
      {
        id: 'flag',
        label: m.isUnread ? 'Mark as read' : 'Mark as unread',
        icon: m.isUnread ? (
          <MailOpen className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <MailIcon className="h-3.5 w-3.5" aria-hidden />
        ),
        onSelect: () => flag.mutate({ id: m.id, op: m.isUnread ? 'read' : 'unread' }),
      },
      {
        id: 'close',
        label: 'Close',
        icon: <X className="h-3.5 w-3.5" aria-hidden />,
        // Only meaningful when a message is open in the reader.
        disabled: !selectedMessageId || !onClose,
        onSelect: () => onClose?.(),
      },
    ];
  }, [rowMenu, onSelect, flag, selectedMessageId, onClose]);

  /** Run a bulk move, then notify the parent if the currently-open message
   *  was in the selection so the reader can clear itself. */
  const runBulkMove = useCallback(
    async (target: { role: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX' }) => {
      if (selectionIds.length === 0) return;
      const ids = selectionIds;
      try {
        await bulkMove.mutateAsync({ ids, target });
        clearSelection();
        if (selectedMessageId && ids.includes(selectedMessageId)) {
          onAfterBulkAction?.(ids);
        }
      } catch {
        // toast already shown by the hook
      }
    },
    [bulkMove, clearSelection, onAfterBulkAction, selectedMessageId, selectionIds],
  );

  const runBulkFlag = useCallback(
    async (op: 'read' | 'unread') => {
      if (selectionIds.length === 0) return;
      try {
        await bulkFlag.mutateAsync({ ids: selectionIds, op });
        // Don't clear the selection on a simple flag change - the user
        // likely wants to keep acting on the same batch.
      } catch {
        // hook surfaces the toast
      }
    },
    [bulkFlag, selectionIds],
  );

  const runBulkDelete = useCallback(async () => {
    if (selectionIds.length === 0) return;
    const ids = selectionIds;
    try {
      await bulkDelete.mutateAsync({ ids });
      clearSelection();
      if (selectedMessageId && ids.includes(selectedMessageId)) {
        onAfterBulkAction?.(ids);
      }
    } catch {
      // hook surfaces the toast
    }
  }, [bulkDelete, clearSelection, onAfterBulkAction, selectedMessageId, selectionIds]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-3">
        {hasSelection ? (
          <BulkActionBar
            count={selectionCount}
            allVisibleSelected={allVisibleSelected}
            someVisibleSelected={someVisibleSelected}
            isTrash={isTrash}
            isSpam={isSpam}
            isTrashOrSpam={isTrashOrSpam}
            disabled={bulkPending}
            onToggleSelectAll={toggleSelectAll}
            onClear={clearSelection}
            onArchive={() => void runBulkMove({ role: 'ARCHIVE' })}
            onTrash={() => void runBulkMove({ role: 'TRASH' })}
            onSpam={() => void runBulkMove({ role: 'SPAM' })}
            onRestoreToInbox={() => void runBulkMove({ role: 'INBOX' })}
            onMarkRead={() => void runBulkFlag('read')}
            onMarkUnread={() => void runBulkFlag('unread')}
            onPermanentDelete={() => setConfirmBulkDelete(true)}
          />
        ) : (
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-disabled"
                aria-hidden
              />
              <Input
                type="search"
                placeholder="Search mail..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
                aria-label="Search messages"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {items.length > 0 ? (
                <label
                  className="whitespace-nowrap mr-1 inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium text-ink-muted hover:bg-line"
                  title="Select all messages in this folder"
                >
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all messages"
                  />
                  Select all
                </label>
              ) : null}
              <FilterChip
                active={unreadOnly}
                onClick={() => setUnreadOnly((v) => !v)}
                label="Unread"
              />
              <FilterChip
                active={starredOnly}
                onClick={() => setStarredOnly((v) => !v)}
                label="Starred"
              />
              <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={handleRefresh}
                  disabled={refreshing}
                  title="Refresh - fetch new mail now"
                  aria-label="Refresh mail"
                  className="h-7 px-2 text-[11px] text-ink-muted"
                >
                  <RefreshCw
                    className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')}
                  />
                  Refresh
                </Button>
                {folderId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => markAllRead.mutate(folderId)}
                    disabled={markAllRead.isPending || items.length === 0}
                    title="Mark all as read"
                    aria-label="Mark all as read"
                    className="h-7 px-2 text-[11px] text-ink-muted"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Mark all read
                  </Button>
                ) : null}
                {folderId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmResync(true)}
                    disabled={resyncFolder.isPending}
                    title="Resync folder - fetch every message again to repair missing attachments or flags"
                    aria-label="Resync folder"
                    className="h-7 px-2 text-[11px] text-ink-muted"
                  >
                    <RotateCcw
                      className={cn('h-3.5 w-3.5', resyncFolder.isPending && 'animate-spin')}
                    />
                    {resyncFolder.isPending ? 'Resyncing…' : 'Resync'}
                  </Button>
                ) : null}
                {isTrashOrSpam && folderId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmEmpty(true)}
                    disabled={emptyFolder.isPending || items.length === 0}
                    title={isTrash ? 'Empty Trash' : 'Empty Spam'}
                    aria-label={isTrash ? 'Empty Trash' : 'Empty Spam'}
                    className="h-7 px-2 text-[11px] text-state-error hover:text-state-error"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Empty {isTrash ? 'Trash' : 'Spam'}
                  </Button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmEmpty}
        onOpenChange={setConfirmEmpty}
        title={`Empty ${isTrash ? 'Trash' : 'Spam'}?`}
        description={`This permanently deletes every message in ${
          isTrash ? 'Trash' : 'Spam'
        }. The action cannot be undone.`}
        confirmLabel="Empty"
        variant="destructive"
        pending={emptyFolder.isPending}
        onConfirm={async () => {
          if (!folderId) return;
          try {
            await emptyFolder.mutateAsync(folderId);
            setConfirmEmpty(false);
          } catch {
            // toasted by the hook's onError; keep the dialog open to retry
          }
        }}
      />

      <ConfirmDialog
        open={confirmResync}
        onOpenChange={setConfirmResync}
        title={`Resync ${folder?.name ?? 'this folder'}?`}
        description="Every message in the folder is fetched again from the mail server to repair missing attachments or out-of-date flags. Nothing is deleted. On a large folder this can take a few minutes, and a folder can be resynced once every 2 minutes."
        confirmLabel="Resync"
        onConfirm={() => {
          if (!folderId) return;
          setConfirmResync(false);
          resyncFolder.mutate(folderId);
        }}
      />

      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Permanently delete ${selectionCount} message${
          selectionCount === 1 ? '' : 's'
        }?`}
        description="The selected messages will be removed from the server. This action cannot be undone."
        confirmLabel="Delete forever"
        variant="destructive"
        pending={bulkDelete.isPending}
        onConfirm={async () => {
          await runBulkDelete();
          setConfirmBulkDelete(false);
        }}
      />

      {/* min-h-0 is load-bearing here: without it the flex child uses its
          content height as its minimum, which means overflow-y-auto never
          engages and the list grows past the pane. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        role="list"
        aria-label="Messages"
      >
        {isLoading ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12">
            <Loader label="Loading messages" />
          </div>
        ) : isError && !data ? (
          <div className="p-3">
            <QueryError compact message="Couldn't load messages." onRetry={() => void refetch()} />
          </div>
        ) : items.length === 0 ? (
          <p className="px-6 py-12 text-center text-sm text-ink-muted">
            {debouncedSearch.trim()
              ? 'No messages match that search.'
              : 'This folder is empty.'}
          </p>
        ) : (
          <ul className="divide-y divide-line" role="list">
            {items.map((m) => (
              <li key={m.id}>
                <MessageRow
                  message={m}
                  selected={selectedMessageId === m.id}
                  checked={selectedIds.has(m.id)}
                  onSelect={handleSelectRow}
                  onToggleChecked={handleToggleOne}
                  onToggleStar={handleToggleStar}
                  onShare={handleShare}
                  onContextMenu={handleRowContextMenu}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pager - shown whenever there's a page to move to in either
          direction. Mirrors Gmail's 50-at-a-time Newer/Older stepping. */}
      {pageIndex > 0 || hasNextPage ? (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2">
          <span className="mr-auto text-[11px] text-ink-muted">
            {rangeStart}-{rangeEnd}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={goNewer}
            disabled={pageIndex === 0}
            aria-label="Newer messages"
            className="h-7 px-2 text-[11px] text-ink-muted"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Newer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={goOlder}
            disabled={!hasNextPage}
            aria-label="Older messages"
            className="h-7 px-2 text-[11px] text-ink-muted"
          >
            Older
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      {shareTarget ? (
        <ShareToChatDialog
          open={shareTarget !== null}
          onOpenChange={(next) => {
            if (!next) setShareTarget(null);
          }}
          itemType="email"
          itemId={shareTarget.id}
          itemLabel={shareTarget.label}
        />
      ) : null}

      <ContextMenu
        position={rowMenu?.position ?? null}
        items={rowMenuItems}
        onClose={() => setRowMenu(null)}
        ariaLabel="Message actions"
      />
    </div>
  );
}

/**
 * The toolbar that replaces the search + filters row whenever the user has
 * one or more rows selected. Kept tight (single row) so it doesn't shift
 * the messages list down when the user enters selection mode. Action icons
 * adapt to context: "Restore to Inbox" shows inside Trash/Spam; "Not spam"
 * replaces the spam button inside Spam; "Permanently delete" only appears
 * inside Trash/Spam.
 */
function BulkActionBar({
  count,
  allVisibleSelected,
  someVisibleSelected,
  isTrash,
  isSpam,
  isTrashOrSpam,
  disabled,
  onToggleSelectAll,
  onClear,
  onArchive,
  onTrash,
  onSpam,
  onRestoreToInbox,
  onMarkRead,
  onMarkUnread,
  onPermanentDelete,
}: {
  count: number;
  allVisibleSelected: boolean;
  someVisibleSelected: boolean;
  isTrash: boolean;
  isSpam: boolean;
  isTrashOrSpam: boolean;
  disabled: boolean;
  onToggleSelectAll: () => void;
  onClear: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSpam: () => void;
  onRestoreToInbox: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onPermanentDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Checkbox
        checked={
          allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false
        }
        onCheckedChange={onToggleSelectAll}
        aria-label={allVisibleSelected ? 'Clear selection' : 'Select all visible'}
        className="ml-1"
      />
      <span className="ml-2 text-xs font-medium text-ink">
        {count} selected
      </span>
      <div className="ml-2 flex flex-wrap items-center gap-0.5">
        <BulkActionButton
          icon={MailOpen}
          label="Mark read"
          onClick={onMarkRead}
          disabled={disabled}
        />
        <BulkActionButton
          icon={MailIcon}
          label="Mark unread"
          onClick={onMarkUnread}
          disabled={disabled}
        />
        <div className="mx-1 h-4 w-px bg-line" aria-hidden />
        {/* Archive is meaningful in every folder except Archive itself; we
            keep it visible everywhere for now and rely on the server's
            "already there" no-op behavior. */}
        <BulkActionButton
          icon={Archive}
          label="Archive"
          onClick={onArchive}
          disabled={disabled}
        />
        {isTrashOrSpam ? (
          <BulkActionButton
            icon={Inbox}
            label={isSpam ? 'Not spam' : 'Restore to Inbox'}
            onClick={onRestoreToInbox}
            disabled={disabled}
          />
        ) : null}
        {!isSpam ? (
          <BulkActionButton
            icon={ShieldAlert}
            label="Mark as spam"
            onClick={onSpam}
            disabled={disabled}
          />
        ) : null}
        {!isTrash ? (
          <BulkActionButton
            icon={Trash2}
            label="Move to Trash"
            onClick={onTrash}
            disabled={disabled}
          />
        ) : null}
        {isTrashOrSpam ? (
          <BulkActionButton
            icon={Trash2}
            label="Delete forever"
            onClick={onPermanentDelete}
            disabled={disabled}
            destructive
          />
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Clear selection"
        onClick={onClear}
        disabled={disabled}
        className="ml-auto h-7 w-7 min-h-0 min-w-0 text-ink-muted hover:text-ink"
      >
        <X className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

function BulkActionButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  destructive,
}: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'h-7 px-2 text-[11px]',
        destructive ? 'text-state-error hover:text-state-error' : 'text-ink-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}

const MessageRow = memo(function MessageRow({
  message,
  selected,
  checked,
  onSelect,
  onToggleChecked,
  onToggleStar,
  onShare,
  onContextMenu,
}: {
  message: MailMessageListItem;
  selected: boolean;
  checked: boolean;
  onSelect: (id: string) => void;
  onToggleChecked: (id: string) => void;
  onToggleStar: (id: string, isStarred: boolean) => void;
  onShare: (id: string, label: string) => void;
  onContextMenu?: (message: MailMessageListItem, e: React.MouseEvent) => void;
}) {
  const sender = message.fromName?.trim() || message.fromAddress;
  return (
    <div
      onClick={() => onSelect(message.id)}
      onContextMenu={(e) => onContextMenu?.(message, e)}
      className={cn(
        'group flex w-full cursor-pointer items-start gap-2 px-3 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        checked ? 'bg-brand-50/60' : selected ? 'bg-brand-50' : 'hover:bg-bg-subtle',
      )}
    >
      {/* Checkbox cell. Stops propagation so toggling selection doesn't
          also open the reader. */}
      <span
        onClick={(e) => {
          e.stopPropagation();
          onToggleChecked(message.id);
        }}
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center"
      >
        <Checkbox
          checked={checked}
          onCheckedChange={() => onToggleChecked(message.id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={checked ? 'Deselect message' : 'Select message'}
        />
      </span>
      <span
        role="button"
        aria-label={message.isStarred ? 'Unstar' : 'Star'}
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(message.id, message.isStarred);
        }}
        className={cn(
          'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded',
          message.isStarred ? 'text-amber-500' : 'text-line-strong hover:text-amber-400',
        )}
      >
        <Star className="h-4 w-4" fill={message.isStarred ? 'currentColor' : 'none'} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 truncate text-sm',
              message.isUnread ? 'font-semibold text-ink' : 'text-ink',
            )}
          >
            {sender}
          </span>
          {message.hasAttachments ? (
            <Paperclip className="h-3 w-3 shrink-0 text-ink-disabled" aria-label="Has attachments" />
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] text-ink-disabled">
            {relativeTime(message.receivedAt)}
          </span>
        </span>
        <span
          className={cn(
            'mt-0.5 block truncate text-sm',
            message.isUnread ? 'font-medium text-ink' : 'text-ink-muted',
          )}
        >
          {message.subject || '(no subject)'}
        </span>
        <span className="mt-0.5 block truncate text-xs text-ink-muted">
          {message.bodyTextPreview}
        </span>
      </span>
      <button
        type="button"
        aria-label="Share to chat"
        onClick={(e) => {
          e.stopPropagation();
          onShare(message.id, message.subject || sender);
        }}
        className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded text-ink-disabled opacity-0 transition group-hover:opacity-100 hover:bg-bg-subtle hover:text-brand-teal sm:inline-flex"
      >
        <Send className="h-3.5 w-3.5" />
      </button>
    </div>
  );
});

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:shadow-focus',
        active
          ? 'bg-brand-100 text-brand-700'
          : 'bg-bg-subtle text-ink-muted hover:bg-line',
      )}
    >
      {label}
    </button>
  );
}
