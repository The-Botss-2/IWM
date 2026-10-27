import { z } from 'zod';

import { cuid } from './common/id.js';

/**
 * LiveKit token request. The server validates the caller's right to join
 * the underlying chat room / voice channel and mints a JWT scoped to that
 * room name. Tokens are short-lived (TTL ~6h) and single-room.
 */
export const livekitTokenRequestSchema = z.object({
  /**
   * Subject - what to scope the token to:
   * - `chat-room` joins a per-chat-room LiveKit room (DM/GROUP voice/video
   *   call). Server resolves the LiveKit room name from the chat room id
   *   so client code never has to construct it.
   * - `voice-channel` is the persistent Discord-style voice channel
   *   model. The chat room id maps to a LiveKit room of the same identity
   *   and stays open as long as anyone is in it.
   */
  kind: z.enum(['chat-room', 'voice-channel']),
  /** The ChatRoom id that backs the LiveKit room. */
  roomId: cuid,
  /** Whether the user intends to publish video. The token grants the
   *  capability either way; this hint helps the server tune defaults. */
  withVideo: z.boolean().optional(),
});
export type LivekitTokenRequest = z.infer<typeof livekitTokenRequestSchema>;

export const livekitTokenResponseSchema = z.object({
  /** WSS URL of the LiveKit server (read from `LIVEKIT_URL` on the API). */
  url: z.string().url(),
  /** Signed JWT the client passes to `livekit-client.Room.connect()`. */
  token: z.string().min(1),
  /** LiveKit room name (server-derived). Surface for debugging only. */
  roomName: z.string().min(1),
  /** Identity the token was issued for. Used by the client to match the
   *  participant identity reported by LiveKit. */
  identity: z.string().min(1),
});
export type LivekitTokenResponse = z.infer<typeof livekitTokenResponseSchema>;
