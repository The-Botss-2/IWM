import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CHAT_REQUEST_SENT_NOTICE,
  chatRequestBlockListSchema,
  chatRequestBlockSchema,
  chatRequestOkSchema,
  chatRequestSentResponseSchema,
  chatRoomSummarySchema,
  incomingChatRequestListSchema,
  outgoingChatRequestListSchema,
  type ChatRequestBlock,
  type ChatRequestBlockList,
  type ChatRequestOk,
  type ChatRequestSentResponse,
  type ChatRoomMessage,
  type ChatRoomSummary,
  type CreateChatRequestInput,
  type DeclineChatRequestInput,
  type IncomingChatRequestList,
  type OutgoingChatRequest,
  type OutgoingChatRequestList,
} from '@botss/shared-types';

import type { AuthedUser } from '../common/decorators/current-user.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  type ChatRequestViewer,
  incomingRequestWhere,
  outgoingState,
  repeatSendAction,
  requestReachesAccount,
} from './chat-request-rules';
import { ChatService } from './chat.service';

/** Send caps, checked before anything else on the send path. */
const SEND_LIMITS = {
  userHour: { max: 10, ttl: 60 * 60 },
  userDay: { max: 30, ttl: 24 * 60 * 60 },
  orgDay: { max: 200, ttl: 24 * 60 * 60 },
} as const;
/** Bell rows one person can receive from chat requests per hour. */
const NOTIFY_PER_RECIPIENT_HOUR = 20;
const INCOMING_LIMIT = 50;
const OUTGOING_LIMIT = 100;

type ChatRequestCaller = Pick<AuthedUser, 'id' | 'name' | 'email' | 'organizationId'>;

interface ChatRequestRow {
  id: string;
  recipientEmail: string;
  message: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  sentAt: Date;
  roomId: string | null;
}

/**
 * Cross-organization chat requests (A5).
 *
 * Enumeration safety is the core rule: `send` never looks the recipient up.
 * It stores the email and answers with the same notice for any address, with
 * the same queries in the same order. Delivery (the lookup and the bell row)
 * runs after the response, and the recipient's incoming list is computed when
 * they read it, by matching their own email.
 */
@Injectable()
export class ChatRequestsService {
  private readonly logger = new Logger(ChatRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    private readonly chat: ChatService,
  ) {}

  async send(me: ChatRequestCaller, input: CreateChatRequestInput): Promise<ChatRequestSentResponse> {
    // Depends on the caller only, so it reveals nothing about the address.
    if (!me.organizationId) {
      throw new ForbiddenException({
        title: 'Chat requests need an organization',
        status: 403,
      });
    }
    await this.limit(`chatreq:u:h:${me.id}`, SEND_LIMITS.userHour);
    await this.limit(`chatreq:u:d:${me.id}`, SEND_LIMITS.userDay);
    await this.limit(`chatreq:o:d:${me.organizationId}`, SEND_LIMITS.orgDay);

    const email = input.email.toLowerCase();
    const now = new Date();
    const existing = await this.prisma.client.chatRequest.findUnique({
      where: { requesterId_recipientEmail: { requesterId: me.id, recipientEmail: email } },
    });

    // Exactly one write on every branch.
    let row: ChatRequestRow;
    let deliver = false;
    if (!existing) {
      row = await this.prisma.client.chatRequest.create({
        data: { requesterId: me.id, recipientEmail: email, message: input.message, sentAt: now },
      });
      deliver = true;
    } else {
      const action = repeatSendAction(existing, now);
      if (action === 'reopen') {
        row = await this.prisma.client.chatRequest.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            message: input.message,
            sentAt: now,
            respondedAt: null,
            roomId: null,
            attemptCount: { increment: 1 },
          },
        });
        deliver = true;
      } else if (action === 'quiet-reopen') {
        // Reads as a fresh request to the sender, stays declined for the
        // recipient (see repeatSendAction).
        row = await this.prisma.client.chatRequest.update({
          where: { id: existing.id },
          data: {
            status: 'DECLINED',
            message: input.message,
            sentAt: now,
            attemptCount: { increment: 1 },
          },
        });
      } else {
        row = await this.prisma.client.chatRequest.update({
          where: { id: existing.id },
          data: { attemptCount: { increment: 1 } },
        });
      }
    }

    if (deliver) {
      const id = row.id;
      setImmediate(() => {
        void this.deliver(id).catch((err: unknown) =>
          this.logger.warn(
            `Chat request delivery failed id=${id}: ${(err as Error)?.message ?? 'unknown'}`,
          ),
        );
      });
    }

    return chatRequestSentResponseSchema.parse({
      notice: CHAT_REQUEST_SENT_NOTICE,
      request: toOutgoing(row, now),
    });
  }

  /**
   * Background half of `send`: find who the email belongs to and ring their
   * bell. Silently does nothing when the address is unknown, same-org, a
   * client account, in an inactive org, or the recipient blocked the sender.
   */
  async deliver(requestId: string): Promise<void> {
    const request = await this.prisma.client.chatRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        message: true,
        recipientEmail: true,
        sentAt: true,
        requester: { select: { id: true, name: true, email: true, organizationId: true } },
      },
    });
    if (!request || request.status !== 'PENDING') return;
    const requesterOrgId = request.requester.organizationId;
    if (!requesterOrgId) return;

    const recipient = await this.prisma.client.user.findFirst({
      where: {
        email: { equals: request.recipientEmail, mode: 'insensitive' },
        deletedAt: null,
        accountType: 'STAFF',
        AND: [{ organizationId: { not: null } }, { organizationId: { not: requesterOrgId } }],
        organization: { isActive: true, deletedAt: null },
      },
      select: { id: true, createdAt: true },
    });
    // An account created after the request was sent never inherits it.
    if (!recipient || !requestReachesAccount(request.sentAt, recipient.createdAt)) return;

    const blocked = await this.prisma.client.chatRequestBlock.findUnique({
      where: {
        blockerId_blockedUserId: { blockerId: recipient.id, blockedUserId: request.requester.id },
      },
      select: { id: true },
    });
    if (blocked) return;

    const notifyKey = `chatreq:notify:${recipient.id}`;
    const count = await this.redis.client.incr(notifyKey);
    if (count === 1) await this.redis.client.expire(notifyKey, 60 * 60);
    // Still visible in their incoming list; only the bell row is skipped.
    if (count > NOTIFY_PER_RECIPIENT_HOUR) return;

    const name = request.requester.name?.trim() || request.requester.email;
    await this.notifications.emit({
      userId: recipient.id,
      actorId: request.requester.id,
      type: 'CHAT_REQUEST',
      title: `${name} wants to chat`,
      body: request.message.slice(0, 200),
      entityType: 'chat_request',
      entityId: request.id,
      url: '/chat?requests=1',
    });
  }

  async listIncoming(me: ChatRequestCaller): Promise<IncomingChatRequestList> {
    const viewer = await this.toViewer(me);
    if (!viewer) return incomingChatRequestListSchema.parse({ items: [] });
    const rows = await this.prisma.client.chatRequest.findMany({
      where: incomingRequestWhere(viewer, new Date()),
      orderBy: { sentAt: 'desc' },
      take: INCOMING_LIMIT,
      select: {
        id: true,
        message: true,
        sentAt: true,
        requester: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            organization: { select: { name: true } },
          },
        },
      },
    });
    return incomingChatRequestListSchema.parse({
      items: rows.map((r) => ({
        id: r.id,
        message: r.message,
        sentAt: r.sentAt,
        requester: {
          id: r.requester.id,
          name: r.requester.name,
          email: r.requester.email,
          image: r.requester.image,
          organizationName: r.requester.organization?.name ?? null,
        },
      })),
    });
  }

  async listOutgoing(me: ChatRequestCaller): Promise<OutgoingChatRequestList> {
    const rows = await this.prisma.client.chatRequest.findMany({
      where: { requesterId: me.id },
      orderBy: { sentAt: 'desc' },
      take: OUTGOING_LIMIT,
    });
    const now = new Date();
    return outgoingChatRequestListSchema.parse({ items: rows.map((r) => toOutgoing(r, now)) });
  }

  /**
   * Accept: opens (or reuses) the DM through ChatService, then tells the
   * requester. The controller broadcasts the first message so both sidebars
   * pick the room up live.
   */
  async accept(
    me: ChatRequestCaller,
    requestId: string,
  ): Promise<{ room: ChatRoomSummary; message: ChatRoomMessage; requesterId: string }> {
    const result = await this.chat.openDmFromAcceptedRequest(requestId, me.id);
    try {
      // The org name tells the requester WHO accepted: the address they typed
      // could belong to someone they did not expect.
      const name = me.name?.trim() || me.email || 'Someone';
      const who = result.recipientOrganizationName
        ? `${name} (${result.recipientOrganizationName})`
        : name;
      await this.notifications.emit({
        userId: result.requesterId,
        actorId: me.id,
        type: 'CHAT_REQUEST',
        title: `${who} accepted your chat request`,
        body: 'You can chat now.',
        entityType: 'chat_request',
        entityId: requestId,
        url: `/chat/${result.room.id}`,
      });
    } catch (err) {
      this.logger.warn(
        `Chat request accept notification failed id=${requestId}: ${(err as Error)?.message ?? 'unknown'}`,
      );
    }
    return { ...result, room: chatRoomSummarySchema.parse(result.room) };
  }

  /**
   * Decline (optionally block). The requester is never told: their side keeps
   * reading "sent". A block also declines everything else pending from them
   * to this address and hides their future requests.
   */
  async decline(
    me: ChatRequestCaller,
    requestId: string,
    input: DeclineChatRequestInput,
  ): Promise<ChatRequestOk> {
    const viewer = await this.toViewer(me);
    const now = new Date();
    const request = viewer
      ? await this.prisma.client.chatRequest.findFirst({
          where: { id: requestId, ...incomingRequestWhere(viewer, now) },
          select: { id: true, requesterId: true },
        })
      : null;
    if (!viewer || !request) {
      throw new NotFoundException({ title: 'Chat request not found', status: 404 });
    }
    const declined = { status: 'DECLINED' as const, recipientId: me.id, respondedAt: now };
    if (input.block) {
      await this.prisma.client.$transaction([
        this.prisma.client.chatRequestBlock.upsert({
          where: {
            blockerId_blockedUserId: { blockerId: me.id, blockedUserId: request.requesterId },
          },
          create: { blockerId: me.id, blockedUserId: request.requesterId },
          update: {},
        }),
        this.prisma.client.chatRequest.updateMany({
          where: {
            requesterId: request.requesterId,
            recipientEmail: viewer.email.toLowerCase(),
            status: 'PENDING',
          },
          data: declined,
        }),
      ]);
    } else {
      await this.prisma.client.chatRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: declined,
      });
    }
    return chatRequestOkSchema.parse({ ok: true });
  }

  /**
   * The requester withdraws a request that has not been accepted. A declined
   * one cancels the same way (the sender cannot tell them apart); its decline
   * time is kept so re-sending still honours the cool-down.
   */
  async cancel(me: ChatRequestCaller, requestId: string): Promise<ChatRequestOk> {
    const res = await this.prisma.client.chatRequest.updateMany({
      where: { id: requestId, requesterId: me.id, status: { in: ['PENDING', 'DECLINED'] } },
      data: { status: 'CANCELLED' },
    });
    if (res.count === 0) {
      throw new NotFoundException({ title: 'Chat request not found', status: 404 });
    }
    return chatRequestOkSchema.parse({ ok: true });
  }

  async listBlocks(me: ChatRequestCaller): Promise<ChatRequestBlockList> {
    const rows = await this.prisma.client.chatRequestBlock.findMany({
      where: { blockerId: me.id },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        blocked: { select: { id: true, name: true, email: true, image: true } },
      },
    });
    return chatRequestBlockListSchema.parse({
      items: rows.map((r) => ({ user: r.blocked, blockedAt: r.createdAt })),
    });
  }

  async unblock(me: ChatRequestCaller, blockedUserId: string): Promise<ChatRequestOk> {
    // ChatRequestBlock is not soft-deleted: an unblock removes the row.
    const res = await this.prisma.client.chatRequestBlock.deleteMany({
      where: { blockerId: me.id, blockedUserId },
    });
    if (res.count === 0) {
      throw new NotFoundException({ title: 'Block not found', status: 404 });
    }
    return chatRequestOkSchema.parse({ ok: true });
  }

  /**
   * Block someone you share a cross-organization DM with (after accepting
   * their request there is no request left to "Decline & block"). Anyone
   * else is a 404 that says nothing about whether the person exists.
   */
  async block(me: ChatRequestCaller, userId: string): Promise<ChatRequestBlock> {
    if (!(await this.chat.hasCrossOrgDmWith(me.id, userId))) {
      throw new NotFoundException({ title: 'Chat not found', status: 404 });
    }
    const row = await this.prisma.client.chatRequestBlock.upsert({
      where: { blockerId_blockedUserId: { blockerId: me.id, blockedUserId: userId } },
      create: { blockerId: me.id, blockedUserId: userId },
      update: {},
      select: {
        createdAt: true,
        blocked: { select: { id: true, name: true, email: true, image: true } },
      },
    });
    return chatRequestBlockSchema.parse({ user: row.blocked, blockedAt: row.createdAt });
  }

  /** The caller as a request recipient. AuthedUser has no createdAt, so it
   *  is read here (one primary-key lookup) rather than widening AuthGuard. */
  private async toViewer(me: ChatRequestCaller): Promise<ChatRequestViewer | null> {
    if (!me.organizationId || !me.email) return null;
    const row = await this.prisma.client.user.findUnique({
      where: { id: me.id },
      select: { createdAt: true },
    });
    if (!row) return null;
    return {
      id: me.id,
      email: me.email,
      organizationId: me.organizationId,
      createdAt: row.createdAt,
    };
  }

  /** INCR + EXPIRE counter, the same pattern as task-forms and signatures. */
  private async limit(key: string, rule: { max: number; ttl: number }): Promise<void> {
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, rule.ttl);
    if (count > rule.max) {
      throw new HttpException(
        {
          title: 'Too many chat requests',
          status: 429,
          detail: 'You have sent a lot of chat requests. Please try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

function toOutgoing(row: ChatRequestRow, now: Date): OutgoingChatRequest {
  const state = outgoingState(row, now);
  return {
    id: row.id,
    email: row.recipientEmail,
    message: row.message,
    sentAt: row.sentAt,
    state,
    roomId: state === 'ACCEPTED' ? row.roomId : null,
  };
}
