'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { useWhatsAppCall } from '@/hooks/use-whatsapp-call';

/**
 * Lifts the WhatsApp-style call hook into a context so it can be consumed
 * from anywhere in the app shell - the global call overlay in
 * `<GlobalRealtime />`, the chat sidebar "call" button, the chat window
 * header, etc. - without each consumer spinning up its own subscription
 * to the chat socket and racing on the call state.
 */
type CallContextValue = ReturnType<typeof useWhatsAppCall>;

const CallContext = createContext<CallContextValue | null>(null);

export function CallProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const call = useWhatsAppCall(userId);
  return <CallContext.Provider value={call}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error('useCall() must be used inside <CallProvider>');
  }
  return ctx;
}
