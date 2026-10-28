'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2,
  Copy,
  Crown,
  Link2,
  Lock,
  LogOut,
  Pencil,
  Shield,
  ShieldOff,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ChatRoomParticipantRole, ChatRoomSummary } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { UserAvatar } from '@/components/ui/avatar';
import {
  chatRoomsKey,
  useAddParticipants,
  useLeaveRoom,
  useRemoveParticipant,
  useRenameRoom,
  useUpdateRoom,
} from '@/hooks/use-chat';
import { getApi } from '@/lib/api';
import { toast, toastError, toastErrorMessage } from '@/lib/toast';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: ChatRoomSummary;
  currentUserId: string;
}

/**
 * Determine whether the viewer is an admin on this room.
 *
 * Legacy fallback: if no participant in the room has the ADMIN role
 * (older rooms predating the role column), treat everyone as admin so
 * existing groups remain manageable until someone is explicitly promoted.
 */
function useIsRoomAdmin(room: ChatRoomSummary, userId: string): boolean {
  return useMemo(() => {
    const adminCount = room.participants.filter((p) => p.role === 'ADMIN').length;
    if (adminCount === 0) return true;
    const me = room.participants.find((p) => p.userId === userId);
    return me?.role === 'ADMIN';
  }, [room.participants, userId]);
}

export function ChatInfoPanel({ open, onOpenChange, room, currentUserId }: Props) {
  const router = useRouter();
  const isDM = room.type === 'DM';
  const isChannel = room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL';
  const isAdmin = useIsRoomAdmin(room, currentUserId);
  const canManage = !isDM && isAdmin;

  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(room.name ?? '');
  const [addOpen, setAddOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ userId: string; name: string } | null>(null);

  const rename = useRenameRoom();
  const leave = useLeaveRoom();
  const remove = useRemoveParticipant(room.id);

  function startRename(): void {
    setNameDraft(room.name ?? '');
    setRenaming(true);
  }

  async function saveRename(): Promise<void> {
    const next = nameDraft.trim();
    if (!next || next === (room.name ?? '')) {
      setRenaming(false);
      return;
    }
    await rename.mutateAsync({ roomId: room.id, name: next });
    setRenaming(false);
    toast.success('Renamed.');
  }

  async function doLeave(): Promise<void> {
    await leave.mutateAsync(room.id);
    toast.success('Left chat.');
    setConfirmLeave(false);
    onOpenChange(false);
    router.push('/chat');
  }

  if (!open) return null;

  return (
    <>
      <aside
        role="complementary"
        aria-label="Chat info"
        className="border-line flex w-full flex-col border-l bg-white max-md:fixed max-md:inset-0 max-md:z-40 max-md:max-w-none md:max-w-[360px] md:shrink-0"
      >
        <header className="border-line flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-ink text-sm font-semibold">Chat info</h3>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close info"
            onClick={() => onOpenChange(false)}
            className="text-ink-muted h-7 w-7"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section className="text-center">
            {isDM ? (
              <DmHeader room={room} currentUserId={currentUserId} />
            ) : (
              <GroupHeader
                room={room}
                renaming={renaming}
                nameDraft={nameDraft}
                onDraftChange={setNameDraft}
                onStartRename={startRename}
                onCancelRename={() => setRenaming(false)}
                onSaveRename={saveRename}
                renamePending={rename.isPending}
                canEdit={canManage}
              />
            )}
          </section>

          {!isDM ? <DescriptionEditor room={room} canEdit={canManage} /> : null}

          {!isDM && (room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL') ? (
            <ChannelVisibility room={room} canEdit={canManage} />
          ) : null}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h4 className="text-ink-muted text-[11px] font-semibold uppercase tracking-wide">
                {isDM ? 'Participants' : `${room.participants.length} members`}
              </h4>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddOpen(true)}
                  className="text-brand-teal h-7 px-2 text-xs"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Add
                </Button>
              ) : null}
            </div>
            <ul className="space-y-1.5" role="list">
              {room.participants.map((p) => {
                const isSelf = p.userId === currentUserId;
                const isCreator = !!room.createdById && room.createdById === p.userId;
                const role: ChatRoomParticipantRole = p.role ?? 'MEMBER';
                return (
                  <li
                    key={p.id}
                    className="hover:bg-bg-subtle flex items-center gap-3 rounded-md px-2 py-1.5"
                  >
                    <UserAvatar size="sm" name={p.user.name || p.user.email} image={p.user.image} />
                    <div className="min-w-0 flex-1">
                      <div className="text-ink flex flex-wrap items-center gap-1.5 truncate text-sm font-medium">
                        <span className="truncate">{p.user.name || p.user.email}</span>
                        {isSelf ? <span className="text-ink-muted text-[10px]">(you)</span> : null}
                        {isCreator ? (
                          <span
                            title="Creator"
                            className="bg-tint-warning text-brand-orange inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          >
                            <Crown className="h-3 w-3" />
                            Creator
                          </span>
                        ) : role === 'ADMIN' ? (
                          <span
                            title="Admin"
                            className="bg-tint-info text-brand-teal inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          >
                            <Shield className="h-3 w-3" />
                            Admin
                          </span>
                        ) : null}
                      </div>
                      <div className="text-ink-muted truncate text-xs">{p.user.email}</div>
                    </div>
                    {canManage && !isSelf ? (
                      <ParticipantActions
                        roomId={room.id}
                        userId={p.userId}
                        role={role}
                        isCreator={isCreator}
                        onRemove={() =>
                          setConfirmRemove({
                            userId: p.userId,
                            name: p.user.name || p.user.email,
                          })
                        }
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>

          {canManage ? <ShareInviteSection roomId={room.id} /> : null}

          {!isDM ? (
            <section>
              <Button
                variant="ghost"
                onClick={() => setConfirmLeave(true)}
                className="text-state-error hover:bg-tint-error hover:text-state-error w-full justify-start gap-2"
              >
                <LogOut className="h-4 w-4" />
                {isChannel ? 'Leave channel' : 'Exit group'}
              </Button>
            </section>
          ) : null}
        </div>
      </aside>

      <AddMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        room={room}
        currentUserId={currentUserId}
      />

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title={isChannel ? 'Leave this channel?' : 'Exit this group?'}
        description="You won't receive new messages from this conversation."
        confirmLabel="Leave"
        variant="destructive"
        pending={leave.isPending}
        onConfirm={doLeave}
      />

      <ConfirmDialog
        open={confirmRemove !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmRemove(null);
        }}
        title="Remove this member?"
        description={confirmRemove ? `${confirmRemove.name} will lose access to this chat.` : ''}
        confirmLabel="Remove"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!confirmRemove) return;
          await remove.mutateAsync(confirmRemove.userId);
          setConfirmRemove(null);
          toast.success('Member removed.');
        }}
      />
    </>
  );
}

function ParticipantActions({
  roomId,
  userId,
  role,
  isCreator,
  onRemove,
}: {
  roomId: string;
  userId: string;
  role: ChatRoomParticipantRole;
  isCreator: boolean;
  onRemove: () => void;
}) {
  const qc = useQueryClient();
  const updateRole = useMutation({
    mutationFn: (next: ChatRoomParticipantRole) =>
      getApi().chat.updateParticipantRole(roomId, userId, next),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chatRoomsKey });
    },
    meta: { errorTitle: "Couldn't update member role" },
  });

  return (
    <div className="flex items-center gap-1">
      {!isCreator ? (
        role === 'ADMIN' ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Demote to member"
            title="Demote to member"
            disabled={updateRole.isPending}
            onClick={() => updateRole.mutate('MEMBER')}
            className="text-ink-disabled hover:text-ink h-7 w-7"
          >
            <ShieldOff className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Promote to admin"
            title="Promote to admin"
            disabled={updateRole.isPending}
            onClick={() => updateRole.mutate('ADMIN')}
            className="text-ink-disabled hover:text-brand-teal h-7 w-7"
          >
            <Shield className="h-4 w-4" />
          </Button>
        )
      ) : null}
      {!isCreator ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Remove member"
          onClick={onRemove}
          className="text-ink-disabled hover:text-state-error h-7 w-7"
        >
          <UserMinus className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

function DescriptionEditor({ room, canEdit }: { room: ChatRoomSummary; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.description ?? '');
  const update = useUpdateRoom();

  function start(): void {
    setDraft(room.description ?? '');
    setEditing(true);
  }
  async function save(): Promise<void> {
    const next = draft.trim();
    if (next === (room.description ?? '')) {
      setEditing(false);
      return;
    }
    await update.mutateAsync({
      roomId: room.id,
      description: next.length === 0 ? null : next,
    });
    setEditing(false);
    toast.success('Description updated.');
  }

  return (
    <section>
      <h4 className="text-ink-muted mb-2 text-[11px] font-semibold uppercase tracking-wide">
        Description
      </h4>
      {editing && canEdit ? (
        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="What is this chat for?"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={update.isPending}>
              Save
            </Button>
          </div>
        </div>
      ) : room.description ? (
        canEdit ? (
          <button
            type="button"
            onClick={start}
            className="text-ink hover:bg-bg-subtle w-full rounded-md px-2 py-1.5 text-left text-sm"
          >
            {room.description}
          </button>
        ) : (
          <p className="text-ink px-2 py-1.5 text-sm">{room.description}</p>
        )
      ) : canEdit ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={start}
          className="text-ink-muted hover:bg-bg-subtle h-auto w-full justify-start gap-2 px-2 py-1.5 text-xs"
        >
          <Pencil className="h-3.5 w-3.5" />
          Add a description
        </Button>
      ) : (
        <p className="text-ink-disabled px-2 py-1.5 text-xs italic">No description.</p>
      )}
    </section>
  );
}

/**
 * Channel visibility control. Admins can flip a channel between Private
 * (only its participants) and Organization (anyone in the org can find and
 * join). Switching to private restricts the channel to its current
 * participant list - org members who could see it only because it was open
 * lose access - so we confirm before doing it.
 */
function ChannelVisibility({ room, canEdit }: { room: ChatRoomSummary; canEdit: boolean }) {
  const update = useUpdateRoom();
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const isPrivate = room.isPrivate;

  async function setPrivate(next: boolean): Promise<void> {
    if (next === isPrivate) return;
    await update.mutateAsync({ roomId: room.id, isPrivate: next });
    toast.success(
      next
        ? 'Channel is now private. Only its members can see it.'
        : 'Channel is now open to your organization.',
    );
  }

  return (
    <section>
      <h4 className="text-ink-muted mb-2 text-[11px] font-semibold uppercase tracking-wide">
        Visibility
      </h4>
      <div className="bg-bg-subtle flex items-start gap-2 rounded-md px-3 py-2">
        {isPrivate ? (
          <Lock className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Building2 className="text-ink-muted mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-ink text-sm font-medium">
            {isPrivate ? 'Private' : 'Open to your organization'}
          </p>
          <p className="text-ink-muted text-xs">
            {isPrivate
              ? 'Only people added to this channel can see it.'
              : 'Anyone in your organization can find and join.'}
          </p>
        </div>
        {canEdit ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={update.isPending}
            onClick={() => (isPrivate ? void setPrivate(false) : setConfirmPrivate(true))}
          >
            {isPrivate ? 'Make open' : 'Make private'}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmPrivate}
        onOpenChange={setConfirmPrivate}
        title="Make this channel private?"
        description="Only people currently in the channel will keep access. Anyone who could see it just because it was open to the organization will lose access. You can switch it back to open later."
        confirmLabel="Make private"
        pending={update.isPending}
        onConfirm={async () => {
          await setPrivate(true);
          setConfirmPrivate(false);
        }}
      />
    </section>
  );
}

function ShareInviteSection({ roomId }: { roomId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => getApi().chat.createInvite(roomId, { expiresInHours: 24 * 7 }),
    onSuccess: async (invite) => {
      const link = `${window.location.origin}/chat/invite/${invite.code}`;
      setUrl(link);
      if (await copyToClipboard(link)) toast.success('Invite link copied to clipboard.');
      else toast.success('Invite link created. Copy it below.');
    },
    onError: (err) => toastError(err, "Couldn't create invite link"),
    meta: { errorTitle: "Couldn't create invite link" },
  });

  async function copy(): Promise<void> {
    if (!url) return;
    if (await copyToClipboard(url)) toast.success('Copied.');
    else
      toastErrorMessage("Couldn't copy", {
        description:
          'Your browser blocked clipboard access. Allow it in site settings, or copy it by hand.',
      });
  }

  return (
    <section>
      <h4 className="text-ink-muted mb-2 text-[11px] font-semibold uppercase tracking-wide">
        Invite link
      </h4>
      {url ? (
        <div className="space-y-2">
          <div className="border-line bg-bg-subtle flex items-center gap-2 rounded-md border px-2 py-1.5">
            <Link2 className="text-ink-disabled h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="text-ink truncate text-xs">{url}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy link"
              onClick={() => void copy()}
              className="text-ink-muted ml-auto h-6 w-6"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-ink-muted text-[11px]">
            Anyone in this workspace who opens this link joins the chat instantly. Expires in 7
            days.
          </p>
        </div>
      ) : (
        <Button
          variant="secondary"
          onClick={() => create.mutate()}
          disabled={create.isPending}
          className="w-full justify-start gap-2"
        >
          <Link2 className="h-4 w-4" />
          {create.isPending ? 'Creating…' : 'Create invite link'}
        </Button>
      )}
    </section>
  );
}

/** Resolves false when the clipboard is unavailable/blocked, so callers never claim a copy that didn't happen. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function DmHeader({ room, currentUserId }: { room: ChatRoomSummary; currentUserId: string }) {
  const peer = room.participants.find((p) => p.userId !== currentUserId);
  if (!peer) return null;
  return (
    <>
      <UserAvatar size="lg" name={peer.user.name || peer.user.email} image={peer.user.image} />
      <h2 className="text-ink mt-3 text-lg font-semibold">{peer.user.name || peer.user.email}</h2>
      <p className="text-ink-muted max-w-full break-all text-xs">{peer.user.email}</p>
    </>
  );
}

function GroupHeader({
  room,
  renaming,
  nameDraft,
  onDraftChange,
  onStartRename,
  onCancelRename,
  onSaveRename,
  renamePending,
  canEdit,
}: {
  room: ChatRoomSummary;
  renaming: boolean;
  nameDraft: string;
  onDraftChange: (v: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSaveRename: () => void;
  renamePending: boolean;
  canEdit: boolean;
}) {
  const seed = room.name ?? '?';
  return (
    <>
      <UserAvatar size="lg" name={seed} image={null} />
      {renaming && canEdit ? (
        <div className="mt-3 space-y-2">
          <Input
            value={nameDraft}
            onChange={(e) => onDraftChange(e.target.value)}
            placeholder="Conversation name"
            autoFocus
          />
          <div className="flex justify-center gap-2">
            <Button size="sm" variant="secondary" onClick={onCancelRename} disabled={renamePending}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSaveRename} disabled={renamePending}>
              Save
            </Button>
          </div>
        </div>
      ) : canEdit ? (
        <button
          type="button"
          onClick={onStartRename}
          className={cn(
            'text-ink hover:bg-bg-subtle mt-3 inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-lg font-semibold',
          )}
          aria-label="Rename"
        >
          {room.name ?? 'Untitled'}
          <Pencil className="text-ink-disabled h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="text-ink mt-3 inline-flex items-center gap-1.5 px-1.5 py-0.5 text-lg font-semibold">
          {room.name ?? 'Untitled'}
        </span>
      )}
      <p className="text-ink-muted mt-1 text-xs uppercase tracking-wide">
        {room.type === 'TEXT_CHANNEL'
          ? 'Channel'
          : room.type === 'VOICE_CHANNEL'
            ? 'Voice channel'
            : 'Group chat'}
      </p>
    </>
  );
}

function AddMembersDialog({
  open,
  onOpenChange,
  room,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: ChatRoomSummary;
  currentUserId: string;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const add = useAddParticipants(room.id);

  // Channels/groups are org-scoped, so the picker lists everyone in the org
  // (same source as DMs and channel creation), not just the current
  // workspace's members - a freshly-created user has no workspace membership
  // yet but can still be added.
  const membersQuery = useQuery({
    queryKey: ['chat', 'contacts'],
    queryFn: () => getApi().chat.listContacts(),
    staleTime: 60_000,
  });
  const existingIds = useMemo(
    () => new Set(room.participants.map((p) => p.userId)),
    [room.participants],
  );
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (membersQuery.data?.items ?? [])
      .filter((u) => u.id !== currentUserId && !existingIds.has(u.id))
      .filter((u) => {
        if (!q) return true;
        return (u.name ?? '').toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
      });
  }, [membersQuery.data, search, currentUserId, existingIds]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(): Promise<void> {
    if (selected.size === 0) return;
    const result = await add.mutateAsync(Array.from(selected));
    toast.success(`Added ${result.added} member${result.added === 1 ? '' : 's'}.`);
    setSelected(new Set());
    setSearch('');
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>
            Pick anyone in your organization. They will join immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="search"
            placeholder="Search people"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul role="listbox" aria-multiselectable className="max-h-72 space-y-1 overflow-y-auto">
            {candidates.length === 0 ? (
              <li className="text-ink-muted px-2 py-4 text-center text-xs">
                {membersQuery.isLoading ? (
                  <Loader size="sm" label="Loading" />
                ) : membersQuery.isError && !membersQuery.data ? (
                  <QueryError
                    compact
                    message="Couldn't load people."
                    onRetry={() => void membersQuery.refetch()}
                  />
                ) : (
                  'No one new to add.'
                )}
              </li>
            ) : (
              candidates.map((u) => {
                const active = selected.has(u.id);
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => toggle(u.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left',
                        active ? 'bg-tint-info' : 'hover:bg-bg-subtle',
                      )}
                    >
                      <UserAvatar size="sm" name={u.name || u.email} image={u.image} />
                      <div className="min-w-0 flex-1">
                        <div className="text-ink truncate text-sm font-medium">
                          {u.name || u.email}
                        </div>
                        <div className="text-ink-muted truncate text-xs">{u.email}</div>
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={selected.size === 0 || add.isPending}>
            {add.isPending ? 'Adding…' : `Add ${selected.size || ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
