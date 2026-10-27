import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  forwardRef,
} from '@nestjs/common';
import {
  type AddParticipantsInput,
  addParticipantsSchema,
  type CreateChatRoomInput,
  createChatRoomSchema,
  type CreateInviteInput,
  createInviteSchema,
  cuid,
  type EditChatMessageBody,
  editChatMessageBodySchema,
  type ForwardChatMessagesBody,
  forwardChatMessagesBodySchema,
  type ListRoomMessagesQuery,
  listRoomMessagesQuerySchema,
  type RenameRoomInput,
  type ShareToChatInput,
  shareToChatSchema,
  type UpdateParticipantRoleInput,
  updateParticipantRoleSchema,
  type UpdateRoomInput,
  updateRoomSchema,
  type SendChatMessageBody,
  type SendChatMessageInput,
  sendChatMessageBodySchema,
  type ToggleReactionInput,
  toggleReactionSchema,
} from '@botss/shared-types';
import { z } from 'zod';

import { AdminUsersService } from '../admin/admin-users.service';
import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Controller('chat')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
    private readonly admin: AdminUsersService,
  ) {}

  @Get('rooms')
  @SkipPermissions()
  listRooms(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
  ) {
    return this.chat.listRoomsForUser(user.id, workspaceId);
  }

  /**
   * People the caller can start a new chat with. Independent of the current
   * workspace - root-org (Botss) users see everyone, tenant users see their
   * own organization. Mounts at GET /chat/contacts.
   */
  @Get('contacts')
  @SkipPermissions()
  listContacts(@CurrentUser() user: AuthedUser) {
    return this.chat.listContactsForUser(user.id);
  }

  @Get('rooms/:roomId/messages')
  @SkipPermissions()
  listMessages(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Query(new ZodValidationPipe(listRoomMessagesQuerySchema.omit({ roomId: true })))
    query: Omit<ListRoomMessagesQuery, 'roomId'>,
  ) {
    return this.chat.listRoomMessages(user.id, { ...query, roomId });
  }

  @Post('rooms')
  @SkipPermissions()
  createRoom(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(createChatRoomSchema)) input: CreateChatRoomInput,
  ) {
    return this.chat.createRoom(user.id, input, workspaceId);
  }

  @Get('rooms/:roomId')
  @SkipPermissions()
  getRoom(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    return this.chat.getRoomDetail(user.id, roomId);
  }

  @Patch('rooms/:roomId')
  @SkipPermissions()
  async updateRoom(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Body(new ZodValidationPipe(updateRoomSchema)) input: UpdateRoomInput,
  ) {
    const { room, systemMessages } = await this.chat.updateRoomWithEvents(user.id, roomId, input);
    for (const message of systemMessages) {
      await this.broadcastSystemMessage(roomId, message);
    }
    return room;
  }

  @Post('rooms/:roomId/participants')
  @SkipPermissions()
  async addParticipants(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Body(new ZodValidationPipe(addParticipantsSchema)) input: AddParticipantsInput,
  ) {
    const { added, systemMessage } = await this.chat.addParticipants(
      user.id,
      roomId,
      input.userIds,
    );
    await this.broadcastSystemMessage(roomId, systemMessage);
    return { added };
  }

  @Delete('rooms/:roomId/participants/:userId')
  @SkipPermissions()
  async removeParticipant(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Param('userId', new ZodValidationPipe(cuid)) targetUserId: string,
  ) {
    const { systemMessage } = await this.chat.removeParticipant(
      user.id,
      roomId,
      targetUserId,
    );
    await this.broadcastSystemMessage(roomId, systemMessage);
    // After the "removed" message, so the removed person still sees it.
    this.gateway.evictFromRoom(targetUserId, roomId);
    return { ok: true };
  }

  @Put('rooms/:roomId/participants/:userId/role')
  @SkipPermissions()
  updateParticipantRole(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Param('userId', new ZodValidationPipe(cuid)) targetUserId: string,
    @Body(new ZodValidationPipe(updateParticipantRoleSchema))
    input: UpdateParticipantRoleInput,
  ) {
    return this.chat.updateParticipantRole(user.id, roomId, targetUserId, input.role);
  }

  @Post('rooms/:roomId/leave')
  @SkipPermissions()
  async leaveRoom(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    const { systemMessage } = await this.chat.leaveRoom(user.id, roomId);
    await this.broadcastSystemMessage(roomId, systemMessage);
    this.gateway.evictFromRoom(user.id, roomId);
    return { ok: true };
  }

  /**
   * Fan a membership-change system message out to the room over the same
   * channel as regular messages, so every connected member sees "X added
   * Y" / "X left" appear live. Best-effort: the DB write already succeeded,
   * so a socket hiccup must not turn the HTTP call into a failure.
   */
  private async broadcastSystemMessage(
    roomId: string,
    message: Awaited<ReturnType<ChatService['leaveRoom']>>['systemMessage'],
  ): Promise<void> {
    if (!message) return;
    try {
      await this.gateway.broadcastNewMessage({
        roomId,
        senderUserId: message.senderId,
        message,
        clientNonce: null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastSystemMessage failed:', err);
    }
  }

  /**
   * Mark every unread message in a room as READ for the caller. Robust
   * HTTP path so the action persists even if the WebSocket isn't open
   * (e.g. user clicks "Mark as read" on the sidebar context menu without
   * the chat-window mounted). After the DB update, the gateway echoes a
   * `msg_status_update` so the sender's blue ticks light up.
   */
  @Post('rooms/:roomId/read')
  @SkipPermissions()
  async markRoomRead(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    const result = await this.chat.markRead(user.id, roomId);
    if (result.updated > 0) {
      try {
        await this.gateway.broadcastReadStatus({
          roomId,
          byUserId: user.id,
          messageIds: result.messageIds,
        });
      } catch (err) {
        // Persistence already succeeded; the broadcast is best-effort.
        // eslint-disable-next-line no-console
        console.error('[chat] broadcastReadStatus failed:', err);
      }
    }
    return { ok: true, updated: result.updated, messageIds: result.messageIds };
  }

  @Post('rooms/:roomId/call/initiate')
  @SkipPermissions()
  async restInitiateCall(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    // Membership BEFORE the force-end: initiateCall checks it too, but only
    // after any live call in the room had already been killed, so a
    // non-member could hang up anyone's call by posting a room id.
    await this.chat.assertRoomMember(user.id, roomId);
    await this.chat.forceEndCallByRoom(roomId);
    const { call, receiverUserIds } = await this.chat.initiateCall(
      user.id,
      `rest:${user.id}`,
      roomId,
    );
    try {
      await this.gateway.broadcastCallIncoming({
        callId: call.id,
        roomId,
        callerId: user.id,
        receiverUserIds,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastCallIncoming failed:', err);
    }
    return { ok: true, call };
  }

  @Post('rooms/:roomId/call/clear')
  @SkipPermissions()
  async restClearCall(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    await this.chat.assertRoomMember(user.id, roomId);
    const { callId, callLog } = await this.chat.forceEndCallByRoom(roomId);
    if (callId) {
      await this.gateway.broadcastCallIncoming({
        callId,
        roomId,
        callerId: user.id,
        receiverUserIds: [],
      });
    }
    if (callLog) {
      await this.gateway.broadcastNewMessage({
        roomId,
        senderUserId: callLog.senderId,
        message: callLog,
        clientNonce: null,
      });
    }
    return { ok: true, callId };
  }

  @Post('rooms/:roomId/messages')
  @SkipPermissions()
  async sendMessage(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Body(new ZodValidationPipe(sendChatMessageBodySchema))
    body: SendChatMessageBody,
  ) {
    const input: SendChatMessageInput = { ...body, roomId };
    const message = await this.chat.sendMessage(user.id, input);
    try {
      await this.gateway.broadcastNewMessage({
        roomId,
        senderUserId: user.id,
        message,
        clientNonce: input.clientNonce ?? null,
      });
    } catch (err) {
      // Persistence already succeeded; never fail the send response over
      // a broadcast hiccup. Other clients will pick the message up on
      // their next list refresh.
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastNewMessage failed:', err);
    }
    return { ok: true, message };
  }

  @Post('rooms/:roomId/invites')
  @SkipPermissions()
  createInvite(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
    @Body(new ZodValidationPipe(createInviteSchema)) input: CreateInviteInput,
  ) {
    return this.chat.createInvite(user.id, roomId, input);
  }

  @Get('invites/:code')
  @SkipPermissions()
  previewInvite(
    @CurrentUser() user: AuthedUser,
    @Param('code', new ZodValidationPipe(z.string().min(4).max(64))) code: string,
  ) {
    return this.chat.previewInvite(user.id, code);
  }

  @Post('invites/:code/accept')
  @SkipPermissions()
  async acceptInvite(
    @CurrentUser() user: AuthedUser,
    @Param('code', new ZodValidationPipe(z.string().min(4).max(64))) code: string,
  ) {
    const { systemMessage, ...result } = await this.chat.acceptInvite(user.id, code);
    await this.broadcastSystemMessage(result.roomId, systemMessage);
    return result;
  }

  @Post('messages/:messageId/reactions')
  @SkipPermissions()
  async toggleReaction(
    @CurrentUser() user: AuthedUser,
    @Param('messageId', new ZodValidationPipe(cuid)) messageId: string,
    @Body(new ZodValidationPipe(toggleReactionSchema)) input: ToggleReactionInput,
  ) {
    const result = await this.chat.toggleReaction(user.id, messageId, input.emoji);
    try {
      await this.gateway.broadcastReactionUpdate(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastReactionUpdate failed:', err);
    }
    return result;
  }

  @Get('admin/rooms')
  @SkipPermissions()
  async adminListRooms(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
  ) {
    await this.admin.assertAdmin(user.id);
    return this.chat.listAdminRoomsForWorkspace(workspaceId, {
      systemRole: user.systemRole,
      organizationId: user.organizationId,
    });
  }

  @Delete('admin/rooms/:roomId')
  @SkipPermissions()
  async adminDeleteRoom(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    await this.admin.assertAdmin(user.id);
    return this.chat.adminDeleteRoom(roomId, {
      systemRole: user.systemRole,
      organizationId: user.organizationId,
    });
  }

  @Delete('messages/:messageId')
  @SkipPermissions()
  async deleteMessage(
    @CurrentUser() user: AuthedUser,
    @Param('messageId', new ZodValidationPipe(cuid)) messageId: string,
  ) {
    const result = await this.chat.deleteMessage(user.id, messageId);
    try {
      await this.gateway.broadcastMessagesPurged({
        roomId: result.roomId,
        messageIds: [result.messageId],
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastMessagesPurged failed:', err);
    }
    return { ok: true, ...result };
  }

  @Patch('messages/:messageId')
  @SkipPermissions()
  async editMessage(
    @CurrentUser() user: AuthedUser,
    @Param('messageId', new ZodValidationPipe(cuid)) messageId: string,
    @Body(new ZodValidationPipe(editChatMessageBodySchema)) body: EditChatMessageBody,
  ) {
    const message = await this.chat.editMessage(user.id, messageId, body.content);
    try {
      await this.gateway.broadcastMessageUpdated({ roomId: message.roomId, message });
    } catch (err) {
      // Persistence succeeded; never fail the edit over a broadcast hiccup.
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastMessageUpdated failed:', err);
    }
    return { ok: true, message };
  }

  @Post('messages/forward')
  @SkipPermissions()
  async forwardMessages(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(forwardChatMessagesBodySchema))
    body: ForwardChatMessagesBody,
  ) {
    const messages = await this.chat.forwardMessages(
      user.id,
      body.messageIds,
      body.targetRoomId,
    );
    for (const message of messages) {
      try {
        await this.gateway.broadcastNewMessage({
          roomId: body.targetRoomId,
          senderUserId: user.id,
          message,
          clientNonce: null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[chat] forward broadcast failed:', err);
      }
    }
    return { ok: true, roomId: body.targetRoomId, count: messages.length };
  }

  @Post('share')
  @SkipPermissions()
  async share(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(shareToChatSchema)) input: ShareToChatInput,
  ) {
    const message = await this.chat.shareToChat(
      user.id,
      input.targetRoomId,
      input.itemType,
      input.itemId,
    );
    try {
      await this.gateway.broadcastNewMessage({
        roomId: input.targetRoomId,
        senderUserId: user.id,
        message,
        clientNonce: null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] share broadcast failed:', err);
    }
    return { ok: true, message };
  }

  @Delete('rooms/:roomId/messages')
  @SkipPermissions()
  async clearRoomMessages(
    @CurrentUser() user: AuthedUser,
    @Param('roomId', new ZodValidationPipe(cuid)) roomId: string,
  ) {
    const result = await this.chat.deleteAllRoomMessages(user.id, roomId);
    try {
      await this.gateway.broadcastMessagesPurged({
        roomId: result.roomId,
        messageIds: 'all',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[chat] broadcastMessagesPurged failed:', err);
    }
    return { ok: true, ...result };
  }
}
