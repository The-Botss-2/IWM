import type { ChatRoomSummary } from '@botss/shared-types';

/**
 * Pure helpers that derive a human label for a chat room. Kept out of the
 * chat UI components so app-shell code (nav rail, global realtime, search)
 * can import them without dragging the whole chat sidebar into its bundle.
 */

/** Display name of the "other" participant in a DM, or `fallback`. */
export function dmPeerName(
  room: ChatRoomSummary,
  currentUserId: string,
  fallback = 'Conversation',
): string {
  const peer = room.participants.find((p) => p.userId !== currentUserId);
  return peer?.user.name ?? peer?.user.email ?? fallback;
}

export interface RoomTitleOptions {
  /**
   * Render voice channels with the text-channel `# name` prefix (used by the
   * forward picker, which lists both kinds together). Default: false, voice
   * channels show their bare name.
   */
  voiceAsChannel?: boolean;
}

/**
 * Canonical room title as shown in the chat sidebar:
 *   - text channel  -> `# name`
 *   - voice channel -> `name` (or `# name` with `voiceAsChannel`)
 *   - group         -> `name`
 *   - DM            -> the peer's name / email
 */
export function roomTitle(
  room: ChatRoomSummary,
  currentUserId: string,
  options: RoomTitleOptions = {},
): string {
  if (room.type === 'TEXT_CHANNEL') return `# ${room.name ?? 'channel'}`;
  if (room.type === 'VOICE_CHANNEL') {
    return options.voiceAsChannel ? `# ${room.name ?? 'channel'}` : room.name ?? 'voice';
  }
  if (room.type === 'GROUP') return room.name ?? 'Group';
  return dmPeerName(room, currentUserId);
}

/**
 * Admin-facing label (organization communication settings). Unlike
 * `roomTitle`, it is not relative to the viewer: DMs list every participant.
 */
export function adminRoomLabel(room: ChatRoomSummary): string {
  if (room.type === 'GROUP' || room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL') {
    return room.name ?? '(untitled)';
  }
  const names = room.participants.map((p) => p.user.name || p.user.email);
  return names.length > 0 ? names.join(' ↔ ') : '(direct message)';
}
