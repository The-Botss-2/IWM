'use client';

import { usePathname } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { CreateChatRoomInput } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import { useCall } from '@/components/chat/call-context';
import { ChatRequestDialog } from '@/components/chat/chat-request-dialog';
import { ChatSidebar } from '@/components/chat/chat-sidebar';
import { NewChatDialog } from '@/components/chat/new-chat-dialog';
import {
  NavPanelPortal,
  useNavPanelAvailable,
} from '@/components/shell/nav-panel-slot';
import { useChatRooms, useCreateChatRoom } from '@/hooks/use-chat';
import { usePresence } from '@/hooks/use-chat-socket';
import { cn } from '@/lib/utils';

interface Props {
  children: ReactNode;
  activeRoomId?: string | null;
}

/**
 * Layout shell for the `/chat` routes. The global chat socket, presence,
 * notification dispatch, incoming-call modal and active-call overlay all
 * live in `<GlobalRealtime />` at the app-shell level - so chat events
 * keep working on every route. This shell only owns chat-page-specific
 * chrome: the room sidebar and the "new chat" dialog.
 */
export function ChatShell({ children }: Props) {
  const session = useSessionContext();
  const userId = session.data?.user?.id ?? '';

  const { data, isLoading, isError, refetch } = useChatRooms();
  const create = useCreateChatRoom();
  const rooms = useMemo(() => data?.items ?? [], [data]);

  const presenceSet = usePresence(userId);
  const call = useCall();
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  async function handleCreate(input: CreateChatRoomInput): Promise<void> {
    let created: Awaited<ReturnType<typeof create.mutateAsync>>;
    try {
      created = await create.mutateAsync(input);
    } catch {
      return; // toasted by useCreateChatRoom's onError; keep the dialog open
    }
    setNewChatOpen(false);
    window.location.href = `/chat/${created.id}`;
  }

  function onStartCall(roomId: string): void {
    void call.startOutgoingCall(roomId);
  }

  // Mobile UX: there isn't room for both the sidebar and an open chat.
  // On `/chat` (index, no room selected) show the chat list full-width
  // so the user can pick. On `/chat/[id]` (a specific room) show the
  // room content full-width - the back button on the room header takes
  // them to `/chat` to switch. md+ shows both columns side-by-side as
  // before.
  const pathname = usePathname();
  const onChatIndex = pathname === '/chat';

  // Under the rail layout the contextual panel becomes this sidebar, so
  // rendering it here as well would show the room list twice side by side.
  // Under the top bar there is no panel, so the inline column stays.
  const inNavPanel = useNavPanelAvailable();

  const sidebar = (
    <ChatSidebar
      rooms={rooms}
      currentUserId={userId}
      onNewChat={() => setNewChatOpen(true)}
      isLoading={isLoading}
      loadError={isError && !data}
      onRetry={() => void refetch()}
      onlineUserIds={presenceSet}
    />
  );

  return (
    <div
      className={cn(
        // Height comes from the chrome (see AppChrome), not a hardcoded
        // top-bar subtraction. The fallback keeps the old top-bar value for
        // anything that renders this outside the app shell.
        'grid h-[var(--app-content-h,calc(100vh-4rem))] min-h-0 grid-cols-1 overflow-hidden',
        inNavPanel ? 'md:grid-cols-1' : 'md:grid-cols-[320px_minmax(0,1fr)]',
      )}
    >
      {inNavPanel ? (
        <NavPanelPortal>{sidebar}</NavPanelPortal>
      ) : (
        <aside
          className={cn(
            'min-h-0 overflow-hidden border-r border-line bg-bg-surface md:flex md:flex-col',
            onChatIndex ? 'flex flex-col' : 'hidden md:flex',
          )}
        >
          {sidebar}
        </aside>
      )}
      <section
        className={cn(
          'min-h-0 min-w-0 flex-col overflow-hidden bg-bg-app md:flex',
          // With the sidebar in the panel there is no second column to fall
          // back to on a phone, so the room content always shows.
          inNavPanel ? 'flex' : onChatIndex ? 'hidden md:flex' : 'flex',
        )}
      >
        <ChatShellContext.Provider value={{ onStartCall }}>
          {children}
        </ChatShellContext.Provider>
      </section>

      {newChatOpen ? (
        <NewChatDialog
          open={newChatOpen}
          onOpenChange={setNewChatOpen}
          pending={create.isPending}
          onSubmit={handleCreate}
          onRequestChat={() => {
            setNewChatOpen(false);
            setRequestOpen(true);
          }}
        />
      ) : null}

      {requestOpen ? (
        <ChatRequestDialog open={requestOpen} onOpenChange={setRequestOpen} />
      ) : null}
    </div>
  );
}

import { createContext, useContext } from 'react';

interface ChatShellContextValue {
  onStartCall: (roomId: string, peerUserId?: string) => void;
}

const ChatShellContext = createContext<ChatShellContextValue>({
  onStartCall: () => undefined,
});

export function useChatShellActions(): ChatShellContextValue {
  return useContext(ChatShellContext);
}
