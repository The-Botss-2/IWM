'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { useSessionContext } from '@/components/auth/session-gate';
import { ChatInfoPanel } from '@/components/chat/chat-info-panel';
import { ChatWindow } from '@/components/chat/chat-window';
import { useChatShellActions } from '@/components/chat/chat-shell';
import { VoiceChannelPanel } from '@/components/chat/voice-channel-panel';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { useChatRooms } from '@/hooks/use-chat';

export default function RoomPage() {
  const params = useParams<{ channelId: string }>();
  const roomId = params.channelId;
  // `?msg=` from search results and notifications: scroll to that message.
  const focusMessageId = useSearchParams().get('msg');
  const session = useSessionContext();
  const { data, isLoading, isError, refetch } = useChatRooms();
  const room = data?.items.find((r) => r.id === roomId);
  const userId = session.data?.user?.id ?? '';
  const { onStartCall } = useChatShellActions();
  const [infoOpen, setInfoOpen] = useState(false);

  if (!roomId || !userId) {
    return (
      <div className="grid flex-1 place-items-center">
        <Loader size="sm" label="Loading" />
      </div>
    );
  }
  if (!room && isError && !data) {
    return (
      <div className="grid flex-1 place-items-center p-4">
        <QueryError
          message="Couldn't load this chat."
          onRetry={() => void refetch()}
        />
      </div>
    );
  }
  if (!room) {
    return (
      <div className="grid flex-1 place-items-center text-sm text-ink-muted">
        {isLoading ? <Loader size="sm" label="Loading chat" /> : 'Chat not found.'}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {room.type === 'VOICE_CHANNEL' ? (
          <VoiceChannelPanel
            key={room.id}
            roomId={room.id}
            channelName={room.name ?? 'voice'}
          />
        ) : null}
        <ChatWindow
          room={room}
          currentUserId={userId}
          onStartCall={onStartCall}
          onOpenInfo={() => setInfoOpen((v) => !v)}
          focusMessageId={focusMessageId}
        />
      </div>
      <ChatInfoPanel
        open={infoOpen}
        onOpenChange={setInfoOpen}
        room={room}
        currentUserId={userId}
      />
    </div>
  );
}
