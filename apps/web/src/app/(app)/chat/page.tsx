'use client';

import { MessageSquare } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef } from 'react';

import { PageLoader } from '@/components/ui/loader';
import { useCreateChatRoom } from '@/hooks/use-chat';

export default function ChatIndexPage() {
  return (
    <Suspense fallback={<ChatIndexEmpty />}>
      <ChatIndexInner />
    </Suspense>
  );
}

/** `/chat?dm=<userId>` opens (or creates) the direct message with that person. */
function ChatIndexInner() {
  const router = useRouter();
  const dm = useSearchParams().get('dm');
  const createRoom = useCreateChatRoom();
  const started = useRef<string | null>(null);

  useEffect(() => {
    if (!dm || started.current === dm) return;
    started.current = dm;
    createRoom
      .mutateAsync({ type: 'DM', participantUserIds: [dm] })
      .then((room) => router.replace(`/chat/${room.id}`))
      // Failure is toasted by useCreateChatRoom's onError; just leave the loader.
      .catch(() => router.replace('/chat'));
  }, [dm, createRoom, router]);

  if (dm) return <PageLoader label="Opening conversation" />;
  return <ChatIndexEmpty />;
}

function ChatIndexEmpty() {
  return (
    <div className="grid flex-1 place-items-center px-6 py-16 text-center">
      <div className="max-w-sm">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-tint-info text-brand-teal">
          <MessageSquare className="h-6 w-6" aria-hidden />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-ink">Pick a chat</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Choose a conversation from the left, or start a new one with the
          pencil icon.
        </p>
      </div>
    </div>
  );
}
