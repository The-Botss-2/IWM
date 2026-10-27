'use client';

import { useEffect, useState } from 'react';

export type ChatTheme = 'light' | 'dark';
export type ChatFontSize = 'sm' | 'md' | 'lg';

export interface ChatAppearance {
  theme: ChatTheme;
  backgroundColor: string;
  fontSize: ChatFontSize;
}

export interface ChatNotifications {
  doNotDisturb: boolean;
  messageSound: boolean;
  callSound: boolean;
  volume: number;
}

const APPEARANCE_KEY = 'botss.chat.appearance.v1';
const NOTIFICATIONS_KEY = 'botss.chat.notifications.v1';

const DEFAULT_APPEARANCE: ChatAppearance = {
  theme: 'light',
  backgroundColor: '#efeae2',
  fontSize: 'md',
};

const DEFAULT_NOTIFICATIONS: ChatNotifications = {
  doNotDisturb: false,
  messageSound: true,
  callSound: true,
  volume: 0.6,
};

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  return safeParse(window.localStorage.getItem(key), fallback);
}

const APPEARANCE_EVT = 'botss-chat-appearance';
const NOTIFICATIONS_EVT = 'botss-chat-notifications';

export function getChatAppearance(): ChatAppearance {
  return read(APPEARANCE_KEY, DEFAULT_APPEARANCE);
}

export function setChatAppearance(next: Partial<ChatAppearance>): void {
  if (typeof window === 'undefined') return;
  const merged = { ...getChatAppearance(), ...next };
  window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(merged));
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVT, { detail: merged }));
}

export function getChatNotifications(): ChatNotifications {
  return read(NOTIFICATIONS_KEY, DEFAULT_NOTIFICATIONS);
}

export function setChatNotifications(next: Partial<ChatNotifications>): void {
  if (typeof window === 'undefined') return;
  const merged = { ...getChatNotifications(), ...next };
  window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(merged));
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_EVT, { detail: merged }));
}

export function useChatAppearance(): ChatAppearance {
  const [value, setValue] = useState<ChatAppearance>(DEFAULT_APPEARANCE);
  useEffect(() => {
    setValue(getChatAppearance());
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<ChatAppearance>).detail;
      if (next) setValue(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === APPEARANCE_KEY) setValue(getChatAppearance());
    };
    window.addEventListener(APPEARANCE_EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(APPEARANCE_EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return value;
}

export function useChatNotifications(): ChatNotifications {
  const [value, setValue] = useState<ChatNotifications>(DEFAULT_NOTIFICATIONS);
  useEffect(() => {
    setValue(getChatNotifications());
    const onChange = (e: Event) => {
      const next = (e as CustomEvent<ChatNotifications>).detail;
      if (next) setValue(next);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === NOTIFICATIONS_KEY) setValue(getChatNotifications());
    };
    window.addEventListener(NOTIFICATIONS_EVT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(NOTIFICATIONS_EVT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return value;
}

export const fontSizeClass: Record<ChatFontSize, string> = {
  sm: 'text-[12px]',
  md: 'text-[14px]',
  lg: 'text-[16px]',
};
