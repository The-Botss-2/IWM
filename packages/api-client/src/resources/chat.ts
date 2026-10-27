import { z } from 'zod';
import {
  type AddParticipantsInput,
  type ChatRequestBlock,
  chatRequestBlockSchema,
  type ChatRequestBlockList,
  chatRequestBlockListSchema,
  type ChatRequestOk,
  chatRequestOkSchema,
  type ChatRequestSentResponse,
  chatRequestSentResponseSchema,
  type CreateChatRequestInput,
  type DeclineChatRequestInput,
  type IncomingChatRequestList,
  incomingChatRequestListSchema,
  type OutgoingChatRequestList,
  outgoingChatRequestListSchema,
  type ChatContactsResponse,
  chatContactsResponseSchema,
  type ChatRoomInvite,
  chatRoomInviteSchema,
  type ChatRoomListResponse,
  chatRoomListResponseSchema,
  type ChatRoomMessage,
  chatRoomMessageSchema,
  type ChatRoomMessagesResponse,
  chatRoomMessagesResponseSchema,
  type ChatRoomParticipantRole,
  type ChatRoomSummary,
  chatRoomSummarySchema,
  type CreateChatRoomInput,
  type CreateInviteInput,
  type EditChatMessageBody,
  type InvitePreview,
  invitePreviewSchema,
  type RenameRoomInput,
  type SendChatMessageBody,
  type UpdateRoomInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

export interface ListRoomMessagesArgs {
  roomId: string;
  cursor?: string;
  limit?: number;
}

const okSchema = z.object({ ok: z.literal(true) });
const addParticipantsResultSchema = z.object({
  added: z.number().int().nonnegative(),
});

export class ChatResource {
  constructor(private readonly http: HttpClient) {}

  listRooms(): Promise<ChatRoomListResponse> {
    return this.http.get('/chat/rooms', chatRoomListResponseSchema);
  }

  /** People the current user can start a new chat with, independent of the
   *  active workspace. Root-org members get the entire platform; tenant
   *  members see only their own org. */
  listContacts(): Promise<ChatContactsResponse> {
    return this.http.get('/chat/contacts', chatContactsResponseSchema);
  }

  listMessages(args: ListRoomMessagesArgs): Promise<ChatRoomMessagesResponse> {
    const query: Record<string, unknown> = {};
    if (args.cursor) query['cursor'] = args.cursor;
    if (args.limit) query['limit'] = args.limit;
    return this.http.get(
      `/chat/rooms/${args.roomId}/messages`,
      chatRoomMessagesResponseSchema,
      query,
    );
  }

  createRoom(input: CreateChatRoomInput): Promise<ChatRoomSummary> {
    return this.http.post('/chat/rooms', chatRoomSummarySchema, input);
  }

  renameRoom(roomId: string, input: RenameRoomInput): Promise<ChatRoomSummary> {
    return this.http.patch(`/chat/rooms/${roomId}`, chatRoomSummarySchema, input);
  }

  updateRoom(roomId: string, input: UpdateRoomInput): Promise<ChatRoomSummary> {
    return this.http.patch(`/chat/rooms/${roomId}`, chatRoomSummarySchema, input);
  }

  addParticipants(roomId: string, input: AddParticipantsInput) {
    return this.http.post(
      `/chat/rooms/${roomId}/participants`,
      addParticipantsResultSchema,
      input,
    );
  }

  removeParticipant(roomId: string, userId: string) {
    return this.http.delete(
      `/chat/rooms/${roomId}/participants/${userId}`,
      okSchema,
    );
  }

  updateParticipantRole(
    roomId: string,
    userId: string,
    role: ChatRoomParticipantRole,
  ) {
    return this.http.put(
      `/chat/rooms/${roomId}/participants/${userId}/role`,
      z.object({
        ok: z.literal(true),
        role: z.enum(['ADMIN', 'MEMBER']),
      }),
      { role },
    );
  }

  leaveRoom(roomId: string) {
    return this.http.post(`/chat/rooms/${roomId}/leave`, okSchema, {});
  }

  /**
   * Mark every unread message in a room as READ for the caller.
   * Persists server-side and triggers a `msg_status_update` broadcast so
   * the original senders see their blue ticks light up.
   */
  markRoomRead(roomId: string) {
    return this.http.post(
      `/chat/rooms/${roomId}/read`,
      z.object({
        ok: z.literal(true),
        updated: z.number().int().nonnegative(),
        messageIds: z.array(z.string()),
      }),
      {},
    );
  }

  sendMessage(roomId: string, body: SendChatMessageBody): Promise<{ ok: true; message: ChatRoomMessage }> {
    return this.http.post(
      `/chat/rooms/${roomId}/messages`,
      z.object({ ok: z.literal(true), message: chatRoomMessageSchema }),
      body,
    );
  }

  createInvite(roomId: string, input: CreateInviteInput = {}): Promise<ChatRoomInvite> {
    return this.http.post(
      `/chat/rooms/${roomId}/invites`,
      chatRoomInviteSchema,
      input,
    );
  }

  previewInvite(code: string): Promise<InvitePreview> {
    return this.http.get(`/chat/invites/${code}`, invitePreviewSchema);
  }

  acceptInvite(code: string) {
    return this.http.post(
      `/chat/invites/${code}/accept`,
      z.object({ roomId: z.string(), alreadyJoined: z.boolean() }),
      {},
    );
  }

  adminListRooms(): Promise<ChatRoomListResponse> {
    return this.http.get('/chat/admin/rooms', chatRoomListResponseSchema);
  }

  adminDeleteRoom(roomId: string) {
    return this.http.delete(
      `/chat/admin/rooms/${roomId}`,
      z.object({ ok: z.literal(true) }),
    );
  }

  initiateCall(roomId: string) {
    return this.http.post(
      `/chat/rooms/${roomId}/call/initiate`,
      z.object({
        ok: z.literal(true),
        call: z.object({
          id: z.string(),
          callerId: z.string(),
          receiverRoomId: z.string(),
          status: z.enum(['RINGING', 'ONGOING', 'COMPLETED', 'MISSED', 'REJECTED']),
          startedAt: z.coerce.date(),
          endedAt: z.coerce.date().nullable(),
        }),
      }),
      {},
    );
  }

  deleteMessage(messageId: string) {
    return this.http.delete(
      `/chat/messages/${messageId}`,
      z.object({
        ok: z.literal(true),
        roomId: z.string(),
        messageId: z.string(),
      }),
    );
  }

  editMessage(
    messageId: string,
    body: EditChatMessageBody,
  ): Promise<{ ok: true; message: ChatRoomMessage }> {
    return this.http.patch(
      `/chat/messages/${messageId}`,
      z.object({ ok: z.literal(true), message: chatRoomMessageSchema }),
      body,
    );
  }

  /** Forward selected messages into another room as plain new messages. */
  forwardMessages(
    targetRoomId: string,
    messageIds: string[],
  ): Promise<{ ok: true; roomId: string; count: number }> {
    return this.http.post(
      '/chat/messages/forward',
      z.object({
        ok: z.literal(true),
        roomId: z.string(),
        count: z.number().int().nonnegative(),
      }),
      { targetRoomId, messageIds },
    );
  }

  clearRoomMessages(roomId: string) {
    return this.http.delete(
      `/chat/rooms/${roomId}/messages`,
      z.object({
        ok: z.literal(true),
        roomId: z.string(),
        cleared: z.number().int().nonnegative(),
      }),
    );
  }

  /**
   * Cross-app share. POST a structured-card reference to a target chat
   * room. Returns the created message so the caller can show an
   * optimistic confirmation.
   */
  share(input: {
    targetRoomId: string;
    itemType: 'task' | 'timesheet' | 'todo' | 'email';
    itemId: string;
  }) {
    return this.http.post(
      '/chat/share',
      z.object({ ok: z.literal(true), message: chatRoomMessageSchema }),
      input,
    );
  }

  toggleReaction(messageId: string, emoji: string) {
    return this.http.post(
      `/chat/messages/${messageId}/reactions`,
      z.object({
        messageId: z.string(),
        roomId: z.string(),
        reactions: z.array(
          z.object({
            emoji: z.string(),
            count: z.number().int().nonnegative(),
            reactedByMe: z.boolean(),
            userIds: z.array(z.string()),
          }),
        ),
      }),
      { emoji },
    );
  }

  // --- Cross-organization chat requests -------------------------------------

  /** Same response for every address, whether or not anyone uses it. */
  sendRequest(input: CreateChatRequestInput): Promise<ChatRequestSentResponse> {
    return this.http.post('/chat/requests', chatRequestSentResponseSchema, input);
  }

  listIncomingRequests(): Promise<IncomingChatRequestList> {
    return this.http.get('/chat/requests/incoming', incomingChatRequestListSchema);
  }

  listOutgoingRequests(): Promise<OutgoingChatRequestList> {
    return this.http.get('/chat/requests/outgoing', outgoingChatRequestListSchema);
  }

  /** Opens (or reuses) the DM with the requester and returns it. */
  acceptRequest(requestId: string): Promise<ChatRoomSummary> {
    return this.http.post(`/chat/requests/${requestId}/accept`, chatRoomSummarySchema, {});
  }

  declineRequest(requestId: string, input: DeclineChatRequestInput): Promise<ChatRequestOk> {
    return this.http.post(`/chat/requests/${requestId}/decline`, chatRequestOkSchema, input);
  }

  /** The requester withdraws a request that has not been accepted. */
  cancelRequest(requestId: string): Promise<ChatRequestOk> {
    return this.http.delete(`/chat/requests/${requestId}`, chatRequestOkSchema);
  }

  listRequestBlocks(): Promise<ChatRequestBlockList> {
    return this.http.get('/chat/requests/blocks', chatRequestBlockListSchema);
  }

  /** Block someone you share a cross-organization DM with. */
  blockUser(userId: string): Promise<ChatRequestBlock> {
    return this.http.post('/chat/requests/blocks', chatRequestBlockSchema, { userId });
  }

  unblockRequester(userId: string): Promise<ChatRequestOk> {
    return this.http.delete(`/chat/requests/blocks/${userId}`, chatRequestOkSchema);
  }
}
