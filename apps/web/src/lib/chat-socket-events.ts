import type { ChatRoomMessage, MessageStatus } from '@botss/shared-types';

/**
 * Payload shapes of the chat Socket.IO events the web app listens to, in one
 * place so every listener of the same event agrees on its type. (Chat schemas
 * are deliberately not in `@botss/shared-types` yet, so these are plain TS
 * types over the shared message model.)
 */

/** `room_bumped`: a room received a message (fan-out to every member). */
export interface RoomBumpedPayload {
  roomId: string;
  lastMessage: ChatRoomMessage;
}

/** `msg_status_update`: delivery / read receipts for messages in a room. */
export interface MsgStatusUpdatePayload {
  roomId: string;
  status: MessageStatus;
  byUserId: string;
  messageIds?: string[];
}

/** `messages_purged`: messages (or the whole room) were deleted for everyone. */
export interface MessagesPurgedPayload {
  roomId: string;
  messageIds: string[] | 'all';
}

/** `typing_start` / `typing_stop`. */
export interface TypingPayload {
  roomId: string;
  userId: string;
}

/** `notification_created`: a new bell row for this user (any type). */
export interface NotificationCreatedPayload {
  id: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
}
