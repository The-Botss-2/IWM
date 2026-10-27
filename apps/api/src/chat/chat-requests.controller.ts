import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  forwardRef,
} from '@nestjs/common';
import {
  blockChatUserSchema,
  type BlockChatUserInput,
  createChatRequestSchema,
  cuid,
  declineChatRequestSchema,
  type CreateChatRequestInput,
  type DeclineChatRequestInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ChatRequestsService } from './chat-requests.service';
import { ChatGateway } from './chat.gateway';

/**
 * Cross-organization chat requests. Like every chat route these skip CASL
 * (chat is person-to-person; the service does its own checks) and are closed
 * to client-portal accounts by AuthGuard (no @PortalRoute). Responses are
 * validated against the shared-types schemas inside the service.
 *
 * The literal `blocks` routes are declared before the `:id` ones, and `:id`
 * only accepts a cuid, so `blocks` can never be read as a request id.
 */
@Controller('chat/requests')
export class ChatRequestsController {
  private readonly logger = new Logger(ChatRequestsController.name);

  constructor(
    private readonly requests: ChatRequestsService,
    @Inject(forwardRef(() => ChatGateway))
    private readonly gateway: ChatGateway,
  ) {}

  @Post()
  @SkipPermissions()
  send(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createChatRequestSchema)) input: CreateChatRequestInput,
  ) {
    return this.requests.send(user, input);
  }

  @Get('incoming')
  @SkipPermissions()
  listIncoming(@CurrentUser() user: AuthedUser) {
    return this.requests.listIncoming(user);
  }

  @Get('outgoing')
  @SkipPermissions()
  listOutgoing(@CurrentUser() user: AuthedUser) {
    return this.requests.listOutgoing(user);
  }

  @Get('blocks')
  @SkipPermissions()
  listBlocks(@CurrentUser() user: AuthedUser) {
    return this.requests.listBlocks(user);
  }

  /** Block someone from a cross-organization DM with them (DM header). */
  @Post('blocks')
  @SkipPermissions()
  block(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(blockChatUserSchema)) input: BlockChatUserInput,
  ) {
    return this.requests.block(user, input.userId);
  }

  @Delete('blocks/:userId')
  @SkipPermissions()
  unblock(
    @CurrentUser() user: AuthedUser,
    @Param('userId', new ZodValidationPipe(cuid)) userId: string,
  ) {
    return this.requests.unblock(user, userId);
  }

  @Post(':id/accept')
  @SkipPermissions()
  async accept(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    const { room, message, requesterId } = await this.requests.accept(user, id);
    try {
      // Same event as a normal new message: both people's sidebars pick the
      // room up (room_bumped goes to each participant's user room).
      await this.gateway.broadcastNewMessage({
        roomId: room.id,
        senderUserId: requesterId,
        message,
        clientNonce: null,
      });
    } catch (err) {
      // The DM exists; a broadcast hiccup must not fail the accept.
      this.logger.warn(
        `Chat request accept broadcast failed roomId=${room.id}: ${(err as Error)?.message ?? 'unknown'}`,
      );
    }
    return room;
  }

  @Post(':id/decline')
  @SkipPermissions()
  decline(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(declineChatRequestSchema)) input: DeclineChatRequestInput,
  ) {
    return this.requests.decline(user, id, input);
  }

  @Delete(':id')
  @SkipPermissions()
  cancel(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.requests.cancel(user, id);
  }
}
