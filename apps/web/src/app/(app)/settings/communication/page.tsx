'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  BellOff,
  Hash,
  MessageSquare,
  Moon,
  Palette,
  Sun,
  Trash2,
  Type,
  Users,
  Volume2,
} from 'lucide-react';
import { useMemo, useState, type ChangeEvent } from 'react';
import type { ChatRoomSummary } from '@botss/shared-types';

import { useSessionContext } from '@/components/auth/session-gate';
import {
  BlockedChatRequestersSection,
  SentChatRequestsSection,
} from '@/components/chat/chat-request-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader } from '@/components/ui/loader';
import { QueryError } from '@/components/ui/query-error';
import { getApi } from '@/lib/api';
import {
  fontSizeClass,
  setChatAppearance,
  setChatNotifications,
  useChatAppearance,
  useChatNotifications,
  type ChatFontSize,
  type ChatTheme,
} from '@/lib/chat-prefs';
import { adminRoomLabel } from '@/lib/chat-room-label';
import {
  playMessageBlip,
  playRingtoneOnce,
} from '@/lib/chat-sounds';
import { absoluteTime, relativeTime } from '@/lib/time';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

const adminRoomsKey = ['admin', 'chat-rooms'] as const;

type Tab = 'preferences' | 'management';

export default function CommunicationSettingsPage() {
  const session = useSessionContext();
  const role = session.data?.user?.systemRole;
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<Tab>('preferences');

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <header>
          <h2 className="text-lg font-semibold text-ink">Communication</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            Personalize how chats sound and look on this device.
          </p>
        </header>
        <PreferencesPanel />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold text-ink">Communication</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Personalize your chat experience, or manage workspace rooms.
        </p>
      </header>

      <nav className="inline-flex rounded-md border border-line bg-bg-surface p-0.5" aria-label="Communication tabs">
        <TabButton active={tab === 'preferences'} onClick={() => setTab('preferences')}>
          Preferences
        </TabButton>
        <TabButton active={tab === 'management'} onClick={() => setTab('management')}>
          Management
        </TabButton>
      </nav>

      {tab === 'preferences' ? <PreferencesPanel /> : <AdminCommunicationView />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded px-3 py-1.5 text-sm transition-colors',
        active
          ? 'bg-brand-50 text-brand-700'
          : 'text-ink-muted hover:bg-bg-subtle',
      )}
    >
      {children}
    </button>
  );
}

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

function PreferencesPanel() {
  const appearance = useChatAppearance();
  const notifications = useChatNotifications();

  function onColorPick(e: ChangeEvent<HTMLInputElement>): void {
    setChatAppearance({ backgroundColor: e.target.value });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-line bg-bg-surface p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          <Palette className="h-4 w-4 text-ink-muted" /> Appearance
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
              <label className="ml-2 inline-flex items-center gap-1 text-xs text-ink-muted">
                Custom
                <input
                  type="color"
                  value={appearance.backgroundColor}
                  onChange={onColorPick}
                  className="h-7 w-9 cursor-pointer rounded-md border border-line bg-bg-surface p-0"
                />
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="inline-flex items-center gap-1.5">
              <Type className="h-3.5 w-3.5 text-ink-muted" /> Font size
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
                      ? 'border-brand-teal bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20 dark:text-brand-teal'
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

      <section className="rounded-lg border border-line bg-bg-surface p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
          {notifications.doNotDisturb ? (
            <BellOff className="h-4 w-4 text-ink-muted" />
          ) : (
            <Bell className="h-4 w-4 text-ink-muted" />
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
                onChange={(e) =>
                  setChatNotifications({ volume: Number(e.target.value) })
                }
                className="flex-1 accent-emerald-600"
              />
              <span className="w-10 text-right text-xs text-ink-muted">
                {Math.round(notifications.volume * 100)}%
              </span>
            </div>
            <div className="flex gap-2 pt-1">
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

      <SentChatRequestsSection />
      <BlockedChatRequestersSection />
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
          ? 'border-brand-teal bg-brand-teal/10 text-brand-teal dark:bg-brand-teal/20 dark:text-brand-teal'
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
        'flex items-start justify-between gap-3 rounded-md border border-line px-3 py-2.5',
        disabled ? 'opacity-60' : '',
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="text-xs text-ink-muted">{description}</div>
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
  const isDark = appearance.theme === 'dark';
  return (
    <div className="rounded-md border border-line p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-ink-muted">
        Preview
      </div>
      <div
        className={cn(
          'flex flex-col gap-2 rounded-lg p-3',
          fontSizeClass[appearance.fontSize],
          isDark ? 'dark' : '',
        )}
        style={{ backgroundColor: appearance.backgroundColor }}
      >
        <div
          className={cn(
            'self-start max-w-[78%] rounded-xl rounded-bl-sm px-3 py-1.5 shadow-sm ring-1',
            isDark
              ? 'bg-slate-800 text-slate-100 ring-slate-700'
              : 'bg-white text-ink ring-slate-200',
          )}
        >
          Hey, how&apos;s the new background looking?
        </div>
        <div
          className={cn(
            'self-end max-w-[78%] rounded-xl rounded-br-sm px-3 py-1.5 shadow-sm',
            isDark
              ? 'bg-brand-teal text-white'
              : 'bg-[#d9fdd3] text-ink',
          )}
        >
          Looks great!
        </div>
      </div>
    </div>
  );
}

function AdminCommunicationView() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<
    { id: string; label: string } | null
  >(null);

  const query = useQuery({
    queryKey: adminRoomsKey,
    queryFn: () => getApi().chat.adminListRooms(),
    staleTime: 15_000,
  });
  const remove = useMutation({
    mutationFn: (roomId: string) => getApi().chat.adminDeleteRoom(roomId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminRoomsKey });
      qc.invalidateQueries({ queryKey: ['chat', 'rooms'] });
      toast.success('Conversation archived.');
    },
    meta: { errorTitle: "Couldn't archive conversation" },
  });

  const rooms = useMemo(() => query.data?.items ?? [], [query.data]);

  const counts = useMemo(() => {
    let dm = 0,
      group = 0,
      textChannel = 0,
      voiceChannel = 0;
    for (const r of rooms) {
      if (r.type === 'DM') dm++;
      else if (r.type === 'GROUP') group++;
      else if (r.type === 'TEXT_CHANNEL') textChannel++;
      else if (r.type === 'VOICE_CHANNEL') voiceChannel++;
    }
    return { dm, group, textChannel, voiceChannel };
  }, [rooms]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((r) => {
      const name = (r.name ?? '').toLowerCase();
      const participants = r.participants
        .map((p) => `${p.user.name} ${p.user.email}`)
        .join(' ')
        .toLowerCase();
      return name.includes(q) || participants.includes(q);
    });
  }, [rooms, search]);

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Direct messages" value={counts.dm} icon={MessageSquare} />
        <StatTile label="Groups" value={counts.group} icon={Users} />
        <StatTile label="Text channels" value={counts.textChannel} icon={Hash} />
        <StatTile label="Voice channels" value={counts.voiceChannel} icon={Volume2} />
      </section>

      <section className="rounded-lg border border-line bg-bg-surface">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-ink">Rooms</h3>
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or member"
            className="w-72"
          />
        </header>
        <div className="overflow-x-auto">
          {query.isLoading ? (
            <div className="flex justify-center px-4 py-8">
              <Loader size="sm" label="Loading" />
            </div>
          ) : query.isError && !query.data ? (
            <QueryError message="Couldn't load rooms." onRetry={() => void query.refetch()} />
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-ink-muted">
              {search.trim() ? 'No rooms match that search.' : 'No rooms yet.'}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Members</th>
                  <th className="px-4 py-2">Last activity</th>
                  <th className="px-4 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <Row
                    key={r.id}
                    room={r}
                    onArchive={() =>
                      setConfirmDelete({
                        id: r.id,
                        label: adminRoomLabel(r),
                      })
                    }
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(null);
        }}
        title="Archive this conversation?"
        description={
          confirmDelete
            ? `${confirmDelete.label} will disappear for all members. The data is kept for audit but no one can re-enter the room.`
            : ''
        }
        confirmLabel="Archive"
        variant="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!confirmDelete) return;
          await remove.mutateAsync(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

function StatTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof MessageSquare;
}) {
  return (
    <div className="rounded-lg border border-line bg-bg-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-ink-muted">{label}</span>
        <Icon className="h-4 w-4 text-ink-disabled" aria-hidden />
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
    </div>
  );
}

function Row({
  room,
  onArchive,
}: {
  room: ChatRoomSummary;
  onArchive: () => void;
}) {
  return (
    <tr className="border-t border-line">
      <td className="px-4 py-3">
        <div className="font-medium text-ink">{adminRoomLabel(room)}</div>
        {room.lastMessage ? (
          <div className="mt-0.5 truncate text-xs text-ink-muted">
            {room.lastMessage.content ?? '[attachment]'}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <Badge tone="neutral">{roomTypeLabel(room.type)}</Badge>
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted">
        {room.participants.length}
      </td>
      <td className="px-4 py-3 text-xs text-ink-muted">
        <span title={absoluteTime(room.updatedAt)}>
          {relativeTime(room.updatedAt)}
        </span>
      </td>
      <td className="px-4 py-3 text-right">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Archive ${adminRoomLabel(room)}`}
          onClick={onArchive}
          className="h-7 w-7 text-ink-disabled hover:text-state-error"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </td>
    </tr>
  );
}

function roomTypeLabel(type: ChatRoomSummary['type']): string {
  if (type === 'DM') return 'Direct';
  if (type === 'GROUP') return 'Group';
  if (type === 'TEXT_CHANNEL') return 'Channel';
  if (type === 'VOICE_CHANNEL') return 'Voice';
  return type;
}
