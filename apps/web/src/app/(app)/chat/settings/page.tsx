'use client';

import { Bell, BellOff, Moon, Palette, Sun, Type } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  fontSizeClass,
  setChatAppearance,
  setChatNotifications,
  useChatAppearance,
  useChatNotifications,
  type ChatFontSize,
  type ChatTheme,
} from '@/lib/chat-prefs';
import { playMessageBlip, playRingtoneOnce } from '@/lib/chat-sounds';
import { cn } from '@/lib/utils';

const BACKGROUNDS = [
  { name: 'WhatsApp beige', value: '#efeae2' },
  { name: 'Soft sand', value: '#f5f0e6' },
  { name: 'Mint', value: '#e7f5ee' },
  { name: 'Cool grey', value: '#eef2f7' },
  { name: 'Lavender', value: '#eee7f7' },
  { name: 'Midnight', value: '#0f172a' },
];

const FONT_SIZES: { value: ChatFontSize; label: string }[] = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
];

export default function ChatSettingsPage() {
  const appearance = useChatAppearance();
  const notifications = useChatNotifications();

  function onColorPick(e: ChangeEvent<HTMLInputElement>): void {
    setChatAppearance({ backgroundColor: e.target.value });
  }

  return (
    <div className="mx-auto h-full w-full max-w-3xl overflow-y-auto px-6 py-6">
      <header className="mb-6">
        <h1 className="text-ink text-xl font-semibold">Chat settings</h1>
        <p className="text-ink-muted mt-0.5 text-sm">
          Appearance, sounds, and quiet hours. Stored locally on this device.
        </p>
      </header>

      <section className="border-line rounded-lg border bg-white p-5">
        <div className="text-ink mb-3 flex items-center gap-2 text-sm font-semibold">
          <Palette className="text-ink-muted h-4 w-4" /> Appearance
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Theme</Label>
            <div className="flex gap-2">
              <ThemeButton
                value="light"
                current={appearance.theme}
                onChange={(v) => setChatAppearance({ theme: v })}
              />
              <ThemeButton
                value="dark"
                current={appearance.theme}
                onChange={(v) => setChatAppearance({ theme: v })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Chat background</Label>
            <div className="flex flex-wrap items-center gap-2">
              {BACKGROUNDS.map((bg) => (
                <button
                  key={bg.value}
                  type="button"
                  onClick={() => setChatAppearance({ backgroundColor: bg.value })}
                  aria-label={bg.name}
                  title={bg.name}
                  className={cn(
                    'h-9 w-9 rounded-md border-2 transition',
                    appearance.backgroundColor === bg.value
                      ? 'border-brand-teal ring-2 ring-emerald-200'
                      : 'border-line',
                  )}
                  style={{ backgroundColor: bg.value }}
                />
              ))}
              <label className="text-ink-muted ml-2 inline-flex items-center gap-1 text-xs">
                Custom
                <input
                  type="color"
                  value={appearance.backgroundColor}
                  onChange={onColorPick}
                  className="border-line h-7 w-9 cursor-pointer rounded-md border bg-white p-0"
                />
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="inline-flex items-center gap-1.5">
              <Type className="text-ink-muted h-3.5 w-3.5" /> Font size
            </Label>
            <div className="flex gap-2">
              {FONT_SIZES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setChatAppearance({ fontSize: s.value })}
                  className={cn(
                    'rounded-md border px-3 py-1.5 transition',
                    fontSizeClass[s.value],
                    appearance.fontSize === s.value
                      ? 'border-brand-teal bg-tint-info text-emerald-800'
                      : 'border-line text-ink hover:bg-bg-subtle',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <PreviewBubble />
        </div>
      </section>

      <section className="border-line mt-6 rounded-lg border bg-white p-5">
        <div className="text-ink mb-3 flex items-center gap-2 text-sm font-semibold">
          {notifications.doNotDisturb ? (
            <BellOff className="text-ink-muted h-4 w-4" />
          ) : (
            <Bell className="text-ink-muted h-4 w-4" />
          )}
          Notifications
        </div>

        <div className="space-y-4">
          <ToggleRow
            label="Do not disturb"
            description="Silence all chat sounds and the incoming-call ringer."
            checked={notifications.doNotDisturb}
            onChange={(v) => setChatNotifications({ doNotDisturb: v })}
          />
          <ToggleRow
            label="Play sound on new message"
            description="Short blip when a new message arrives in any chat."
            checked={notifications.messageSound}
            onChange={(v) => setChatNotifications({ messageSound: v })}
            disabled={notifications.doNotDisturb}
          />
          <ToggleRow
            label="Ringtone on incoming call"
            description="Repeated ringtone while a call modal is open."
            checked={notifications.callSound}
            onChange={(v) => setChatNotifications({ callSound: v })}
            disabled={notifications.doNotDisturb}
          />
          <div className="space-y-2">
            <Label>Volume</Label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={notifications.volume}
                onChange={(e) => setChatNotifications({ volume: Number(e.target.value) })}
                className="flex-1 accent-emerald-600"
              />
              <span className="text-ink-muted w-10 text-right text-xs">
                {Math.round(notifications.volume * 100)}%
              </span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => playMessageBlip(notifications.volume)}
              >
                Preview message
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => playRingtoneOnce(notifications.volume)}
              >
                Preview ringtone
              </Button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function ThemeButton({
  value,
  current,
  onChange,
}: {
  value: ChatTheme;
  current: ChatTheme;
  onChange: (v: ChatTheme) => void;
}) {
  const active = current === value;
  const Icon = value === 'light' ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition',
        active
          ? 'border-brand-teal bg-tint-info text-emerald-800'
          : 'border-line text-ink hover:bg-bg-subtle',
      )}
    >
      <Icon className="h-4 w-4" />
      {value === 'light' ? 'Light' : 'Dark'}
    </button>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'border-line flex items-start justify-between gap-3 rounded-md border px-3 py-2.5',
        disabled ? 'opacity-60' : '',
      )}
    >
      <div className="min-w-0">
        <div className="text-ink text-sm font-medium">{label}</div>
        <div className="text-ink-muted text-xs">{description}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 h-4 w-4 accent-emerald-600"
      />
    </label>
  );
}

function PreviewBubble() {
  const appearance = useChatAppearance();
  return (
    <div className="border-line rounded-md border p-3">
      <div className="text-ink-muted mb-2 text-[11px] uppercase tracking-wide">Preview</div>
      <div
        className={cn('flex flex-col gap-2 rounded-lg p-3', fontSizeClass[appearance.fontSize])}
        style={{ backgroundColor: appearance.backgroundColor }}
      >
        <div className="max-w-[78%] self-start rounded-xl rounded-bl-sm bg-white px-3 py-1.5 shadow-sm ring-1 ring-slate-200">
          Hey, how&apos;s the new background looking?
        </div>
        <div className="text-ink max-w-[78%] self-end rounded-xl rounded-br-sm bg-[#d9fdd3] px-3 py-1.5 shadow-sm">
          Looks great! 🌿
        </div>
      </div>
    </div>
  );
}
