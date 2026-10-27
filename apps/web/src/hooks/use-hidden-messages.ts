'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * "Delete for me" semantics - message IDs that this user has hidden on
 * this device. Stored in localStorage so it survives reloads, but it does
 * NOT sync across devices (matches WhatsApp's "delete for me" UX). The
 * server still holds the row; only the user's view is muted.
 */
function keyFor(userId: string): string {
  return `chat_hidden_messages_${userId}`;
}

function readSet(userId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(keyFor(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function writeSet(userId: string, ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(keyFor(userId), JSON.stringify(Array.from(ids)));
}

const EVT = 'botss-chat-hidden-messages';

export function useHiddenMessages(userId: string): {
  hide: (messageId: string) => void;
  isHidden: (messageId: string) => boolean;
} {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;
    setHidden(readSet(userId));
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<string[]>).detail;
      if (Array.isArray(detail)) setHidden(new Set(detail));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === keyFor(userId)) setHidden(readSet(userId));
    };
    window.addEventListener(EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId]);

  const hide = useCallback(
    (messageId: string) => {
      setHidden((prev) => {
        if (prev.has(messageId)) return prev;
        const next = new Set(prev);
        next.add(messageId);
        if (userId) writeSet(userId, next);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(EVT, { detail: Array.from(next) }),
          );
        }
        return next;
      });
    },
    [userId],
  );

  const isHidden = useCallback(
    (messageId: string) => hidden.has(messageId),
    [hidden],
  );

  return { hide, isHidden };
}
