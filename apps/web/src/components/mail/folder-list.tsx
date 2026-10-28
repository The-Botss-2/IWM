'use client';

import {
  Archive,
  FileText,
  Flag,
  Folder,
  Inbox,
  Pencil,
  Send,
  ShieldAlert,
  Star,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import type { MailFolder } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  folders: MailFolder[];
  selectedId: string | null;
  onSelect: (folderId: string) => void;
  onCompose: () => void;
  composeDisabled?: boolean;
  /** Icon-strip variant. Folder labels hide and unread counts shrink into
   *  a corner dot so the column can collapse to ~52px wide. */
  collapsed?: boolean;
}

const ROLE_ICONS: Record<NonNullable<MailFolder['role']>, LucideIcon> = {
  INBOX: Inbox,
  SENT: Send,
  DRAFTS: FileText,
  TRASH: Trash2,
  SPAM: ShieldAlert,
  ARCHIVE: Archive,
  OUTBOX: Send,
  ALL: Folder,
  FLAGGED: Flag,
  IMPORTANT: Star,
};

const ROLE_LABELS: Record<NonNullable<MailFolder['role']>, string> = {
  INBOX: 'Inbox',
  SENT: 'Sent',
  DRAFTS: 'Drafts',
  TRASH: 'Trash',
  SPAM: 'Spam',
  ARCHIVE: 'Archive',
  OUTBOX: 'Outbox',
  ALL: 'All mail',
  FLAGGED: 'Starred',
  IMPORTANT: 'Important',
};

export const FolderList = memo(function FolderList({
  folders,
  selectedId,
  onSelect,
  onCompose,
  composeDisabled,
  collapsed = false,
}: Props) {
  // Surface canonical roles first (Inbox, Sent, Drafts, ...), then any
  // user-named folders below. Position is populated server-side so the
  // client just respects whatever ordering the role detector produced.
  // Memoize so the array isn't re-sorted on parent state changes - this
  // function ran on every mail-page keystroke before because the parent
  // was passing handlers that re-allocated each render.
  const sorted = useMemo(
    () => [...folders].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name)),
    [folders],
  );

  return (
    <div className="flex h-full flex-col">
      <div className={cn(collapsed ? 'p-2' : 'p-3')}>
        <Button
          onClick={onCompose}
          disabled={composeDisabled}
          className={cn('w-full', collapsed && 'h-9 px-0')}
          aria-label={collapsed ? 'Compose new mail' : undefined}
          title={collapsed ? 'Compose' : undefined}
        >
          {collapsed ? <Pencil className="h-4 w-4" aria-hidden /> : 'Compose'}
        </Button>
      </div>

      <nav
        className={cn(
          // min-h-0 lets overflow-y-auto win against the intrinsic content
          // size of the folder list when many folders are present.
          'min-h-0 flex-1 overflow-y-auto pb-3',
          collapsed ? 'px-1.5' : 'px-2',
        )}
        aria-label="Folders"
      >
        <ul className="space-y-0.5" role="list">
          {sorted.map((f) => {
            const Icon = f.role ? ROLE_ICONS[f.role] : Folder;
            const label = f.role ? ROLE_LABELS[f.role] : f.name;
            const active = selectedId === f.id;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onSelect(f.id)}
                  aria-label={
                    collapsed
                      ? `${label}${f.unreadCount > 0 ? ` (${f.unreadCount} unread)` : ''}`
                      : undefined
                  }
                  title={collapsed ? label : undefined}
                  className={cn(
                    'flex w-full items-center rounded-lg text-left transition-colors',
                    'focus-visible:shadow-focus focus-visible:outline-none',
                    collapsed ? 'relative justify-center py-2.5' : 'gap-2 px-3 py-2 text-sm',
                    active ? 'bg-bg-subtle text-ink font-medium' : 'text-ink hover:bg-bg-subtle',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {!collapsed ? <span className="truncate">{label}</span> : null}
                  {f.unreadCount > 0 ? (
                    collapsed ? (
                      <span
                        aria-hidden
                        className="bg-brand-gradient absolute right-1 top-1 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold text-white"
                      >
                        {f.unreadCount > 9 ? '9+' : f.unreadCount}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'ml-auto inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold',
                          active ? 'bg-brand-gradient text-white' : 'bg-bg-subtle text-ink',
                        )}
                      >
                        {f.unreadCount > 99 ? '99+' : f.unreadCount}
                      </span>
                    )
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
});
