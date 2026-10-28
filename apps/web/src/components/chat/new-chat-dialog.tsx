'use client';

import { useQuery } from '@tanstack/react-query';
import { Hash, MessageSquare, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CreateChatRoomInput, RoomType } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { getApi } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onSubmit: (input: CreateChatRoomInput) => Promise<void> | void;
  /** Opens the cross-organization chat request dialog (DM mode link). */
  onRequestChat?: () => void;
}

type DialogMode = 'DM' | 'GROUP' | 'TEXT_CHANNEL';

const MODES: { value: DialogMode; label: string; icon: typeof Hash; helper: string }[] = [
  { value: 'DM', label: 'Direct', icon: MessageSquare, helper: 'Chat with one person.' },
  { value: 'GROUP', label: 'Group', icon: Users, helper: 'Private group with a name.' },
  { value: 'TEXT_CHANNEL', label: 'Channel', icon: Hash, helper: 'Workspace-wide channel.' },
];

export function NewChatDialog({ open, onOpenChange, pending, onSubmit, onRequestChat }: Props) {
  const session = useSessionContext();
  const myId = session.data?.user?.id ?? '';
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<DialogMode>('DM');
  // Channel visibility. Default to private (invite-only, exactly like a
  // group) so a new channel is never accidentally exposed org-wide; the
  // creator opts into org visibility explicitly.
  const [isPrivate, setIsPrivate] = useState(true);

  // Chat people-finder is independent of the active workspace and always
  // scoped to the caller's own organization (server enforces the boundary).
  const usersQuery = useQuery({
    queryKey: ['chat', 'contacts'],
    queryFn: () => getApi().chat.listContacts(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const candidates = useMemo(() => {
    const items = usersQuery.data?.items ?? [];
    const q = search.trim().toLowerCase();
    const users = items.filter((u) => u.id !== myId);
    if (!q) return users;
    return users.filter((u) => {
      const name = (u.name ?? '').toLowerCase();
      const email = u.email.toLowerCase();
      const orgName = (u.organization?.name ?? '').toLowerCase();
      return name.includes(q) || email.includes(q) || orgName.includes(q);
    });
  }, [usersQuery.data, myId, search]);

  const needsName = mode !== 'DM';
  const peerCountOk =
    mode === 'DM' ? selected.size === 1 : mode === 'GROUP' ? selected.size >= 1 : true;
  const canSubmit = peerCountOk && (!needsName || name.trim().length > 0);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (mode === 'DM') {
        if (next.has(id)) next.delete(id);
        else {
          next.clear();
          next.add(id);
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    const ids = Array.from(selected);
    const type: RoomType = mode;
    const base: CreateChatRoomInput = {
      type,
      participantUserIds: ids,
      ...(needsName ? { name: name.trim() } : {}),
      ...(needsName && description.trim() ? { description: description.trim() } : {}),
      ...(mode === 'TEXT_CHANNEL' ? { isPrivate } : {}),
    } as CreateChatRoomInput;
    await onSubmit(base);
  }

  function switchMode(next: DialogMode): void {
    setMode(next);
    if (next === 'DM' && selected.size > 1) {
      setSelected(new Set());
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>
            Pick a direct chat, a group, or a workspace channel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => switchMode(m.value)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs transition-colors',
                    active
                      ? 'border-brand-teal bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20 dark:text-brand-teal'
                      : 'border-line text-ink hover:bg-bg-subtle',
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden />
                  <span className="font-medium">{m.label}</span>
                  <span className="text-ink-muted text-[10px]">{m.helper}</span>
                </button>
              );
            })}
          </div>

          {mode === 'TEXT_CHANNEL' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="channel-name">Channel name</Label>
                <Input
                  id="channel-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="announcements"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="channel-description">Description (optional)</Label>
                <Textarea
                  id="channel-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What is this channel for?"
                  rows={2}
                  maxLength={500}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Who can see this channel?</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setIsPrivate(true)}
                    aria-pressed={isPrivate}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left text-xs transition-colors',
                      isPrivate
                        ? 'border-brand-teal bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20'
                        : 'border-line text-ink hover:bg-bg-subtle',
                    )}
                  >
                    <span className="block font-medium">Private</span>
                    <span className="text-ink-muted mt-0.5 block text-[10px]">
                      Only you and people you add - like a group.
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsPrivate(false)}
                    aria-pressed={!isPrivate}
                    className={cn(
                      'rounded-md border px-3 py-2 text-left text-xs transition-colors',
                      !isPrivate
                        ? 'border-brand-teal bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20'
                        : 'border-line text-ink hover:bg-bg-subtle',
                    )}
                  >
                    <span className="block font-medium">Organization</span>
                    <span className="text-ink-muted mt-0.5 block text-[10px]">
                      Anyone in your organization can find and join.
                    </span>
                  </button>
                </div>
              </div>
              <p className="text-ink-muted text-[11px]">
                {isPrivate
                  ? 'Add people below - they join immediately. No one else can see it.'
                  : 'Everyone in your organization can find and join. Adding people below is optional.'}
              </p>
            </div>
          ) : null}

          {mode === 'GROUP' ? (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor="group-name">Group name</Label>
                <Input
                  id="group-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Mobile team"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="group-description">Description (optional)</Label>
                <Textarea
                  id="group-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Who is this group for?"
                  rows={2}
                  maxLength={500}
                />
              </div>
            </div>
          ) : null}

          <Input
            type="search"
            placeholder="Search people"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul role="listbox" aria-multiselectable className="max-h-56 space-y-1 overflow-y-auto">
            {candidates.length === 0 ? (
              <li className="text-ink-muted px-2 py-4 text-center text-xs">
                {usersQuery.isLoading ? (
                  <Loader size="sm" label="Loading" />
                ) : usersQuery.isError && !usersQuery.data ? (
                  <QueryError
                    compact
                    message="Couldn't load teammates."
                    onRetry={() => void usersQuery.refetch()}
                  />
                ) : (
                  'No teammates.'
                )}
              </li>
            ) : (
              candidates.map((u) => {
                const active = selected.has(u.id);
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => toggle(u.id)}
                      role="option"
                      aria-selected={active}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                        active
                          ? 'bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20 dark:text-brand-teal'
                          : 'hover:bg-bg-subtle',
                      )}
                    >
                      <UserAvatar size="sm" name={u.name || u.email} image={u.image ?? null} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-ink truncate text-sm font-medium">
                            {u.name || u.email}
                          </span>
                        </div>
                        <div className="text-ink-muted truncate text-xs">{u.email}</div>
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
          {mode === 'DM' && onRequestChat ? (
            <button
              type="button"
              onClick={onRequestChat}
              className="text-ink-muted hover:bg-bg-subtle hover:text-ink w-full rounded-md px-2 py-1.5 text-left text-xs transition-colors"
            >
              Someone at another company?{' '}
              <span className="text-brand-teal font-medium">Send a chat request</span>
            </button>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || pending}>
            {pending
              ? 'Creating…'
              : mode === 'DM'
                ? 'Start chat'
                : mode === 'GROUP'
                  ? 'Create group'
                  : 'Create channel'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
