'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, MessageSquare, Users, Volume2 } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import type { InvitePreview } from '@botss/shared-types';

import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/ui/avatar';
import { chatRoomsKey } from '@/hooks/use-chat';
import { getApi } from '@/lib/api';
import { toast, toastError } from '@/lib/toast';

export default function InvitePage() {
  const params = useParams<{ code: string }>();
  const code = params.code;
  const router = useRouter();
  const qc = useQueryClient();

  const preview = useQuery({
    queryKey: ['chat', 'invite', code],
    queryFn: () => getApi().chat.previewInvite(code),
    enabled: !!code,
    retry: false,
    // The page renders its own "invite is no longer valid" state.
    meta: { silentError: true },
  });

  const accept = useMutation({
    mutationFn: () => getApi().chat.acceptInvite(code),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: chatRoomsKey });
      if (res.alreadyJoined) {
        toast.success('You\'re already in this chat.');
      } else {
        toast.success('Joined.');
      }
      router.replace(`/chat/${res.roomId}`);
    },
    onError: (err) => toastError(err, "Couldn't accept invite"),
    meta: { errorTitle: "Couldn't accept invite" },
  });

  useEffect(() => {
    if (preview.data?.alreadyJoined && !accept.isPending) {
      void accept.mutate();
    }
  }, [preview.data?.alreadyJoined, accept]);

  if (preview.isLoading) {
    return <LoadingState />;
  }
  if (preview.isError || !preview.data) {
    return <UnavailableState message="This invite is no longer valid." />;
  }
  return (
    <InviteCard
      preview={preview.data}
      onAccept={() => accept.mutate()}
      onCancel={() => router.push('/chat')}
      pending={accept.isPending}
    />
  );
}

function InviteCard({
  preview,
  onAccept,
  onCancel,
  pending,
}: {
  preview: InvitePreview;
  onAccept: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const Icon = useMemo(() => {
    if (preview.room.type === 'TEXT_CHANNEL') return Hash;
    if (preview.room.type === 'VOICE_CHANNEL') return Volume2;
    if (preview.room.type === 'GROUP') return Users;
    return MessageSquare;
  }, [preview.room.type]);

  const blocked = preview.expired || preview.exhausted;

  return (
    <div className="grid h-full place-items-center px-6 py-12">
      <div className="w-[min(420px,90vw)] rounded-2xl border border-line bg-white p-6 text-center shadow-sm">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-tint-info text-brand-teal">
          <Icon className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold text-ink">
          {preview.room.name ?? (preview.room.type === 'GROUP' ? 'Group chat' : 'Channel')}
        </h1>
        <p className="mt-1 text-xs uppercase tracking-wide text-ink-muted">
          {preview.room.type === 'GROUP'
            ? 'Group invite'
            : preview.room.type === 'TEXT_CHANNEL'
              ? 'Channel invite'
              : preview.room.type === 'VOICE_CHANNEL'
                ? 'Voice channel invite'
                : 'Invite'}
        </p>
        <p className="mt-3 text-sm text-ink-muted">
          {preview.room.participantCount}{' '}
          {preview.room.participantCount === 1 ? 'member' : 'members'}
        </p>

        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-ink-muted">
          <UserAvatar size="sm" name={preview.invitedBy.name} image={preview.invitedBy.image} />
          <span>
            Invited by <span className="font-medium text-ink">{preview.invitedBy.name}</span>
          </span>
        </div>

        {preview.expired ? (
          <p className="mt-4 rounded-md bg-tint-error px-3 py-2 text-xs text-state-error">
            This invite has expired. Ask {preview.invitedBy.name} for a new link.
          </p>
        ) : preview.exhausted ? (
          <p className="mt-4 rounded-md bg-tint-error px-3 py-2 text-xs text-state-error">
            This invite has reached its limit.
          </p>
        ) : preview.alreadyJoined ? (
          <p className="mt-4 rounded-md bg-tint-info px-3 py-2 text-xs text-brand-teal">
            You&apos;re already in this chat - taking you there.
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-center gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onAccept} disabled={pending || blocked}>
            {pending ? 'Joining…' : preview.alreadyJoined ? 'Open chat' : 'Join chat'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid h-full place-items-center text-sm text-ink-muted">
      Looking up invite…
    </div>
  );
}

function UnavailableState({ message }: { message: string }) {
  const router = useRouter();
  return (
    <div className="grid h-full place-items-center px-6 py-12">
      <div className="w-[min(360px,90vw)] rounded-2xl border border-line bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-ink">Invite unavailable</h1>
        <p className="mt-2 text-sm text-ink-muted">{message}</p>
        <Button onClick={() => router.push('/chat')} className="mt-4">
          Back to chat
        </Button>
      </div>
    </div>
  );
}
