import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@botss/database';
import type {
  CallSummary,
  ChatContact,
  ChatReactionTally,
  ChatRoomInvite,
  ChatRoomMessage,
  ChatRoomParticipantRole,
  ChatRoomSummary,
  CreateChatRoomInput,
  CreateInviteInput,
  InvitePreview,
  ListRoomMessagesQuery,
  SendChatMessageInput,
  ShareCardPayload,
  ShareToChatItemType,
} from '@botss/shared-types';
import { isFullWorkspaceAdmin } from '@botss/auth';

import { loadEffectivePermissions } from '../common/permissions/effective-permissions';
import { canSeeProject } from '../common/project-access';
import { orgWorkspaceMembership } from '../common/tenant-scope';
import { NotificationsPushService } from '../notifications/notifications-push.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { incomingRequestWhere } from './chat-request-rules';
import { assertNotBlockedInCrossOrgDm, spansOrganizations } from './cross-org-block';
import {
  CHAT_FANOUT_JOB_OPTIONS,
  CHAT_FANOUT_QUEUE,
  type ChatFanoutJobData,
} from './chat-fanout.queue';

interface CallRecord {
  id: string;
  callerId: string;
  callerSocketId: string;
  roomId: string;
  status: 'RINGING' | 'ONGOING';
  startedAt: Date;
  acceptedByUserIds: Set<string>;
  /** Room participants at ring time. Valid signaling targets. */
  participantIds: Set<string>;
  /** Users already verified as room members for this call, so the frequent
   *  ICE relay can authorize from memory instead of hitting the DB per
   *  candidate. Seeded with the caller; accepters are added on accept. */
  signalers: Set<string>;
}

/**
 * On-the-wire marker prefix that flags a chat message as a synthetic
 * call-log record. The client looks for this exact prefix on `content`
 * and renders the bubble as a centered system row.
 *
 *   __call__:STATUS:DURATION_SECONDS
 *
 * STATUS  - one of CallStatus (COMPLETED, MISSED, REJECTED).
 * DURATION_SECONDS - wall-clock seconds (0 for missed/rejected).
 */
const CALL_LOG_PREFIX = '__call__';
function callLogContent(status: 'COMPLETED' | 'MISSED' | 'REJECTED', durationSec: number): string {
  return `${CALL_LOG_PREFIX}:${status}:${Math.max(0, Math.round(durationSec))}`;
}

/**
 * On-the-wire marker prefix for synthetic "system" messages that announce
 * room membership changes. Like `__call__`, the client recognizes this
 * prefix on `content` and renders a centered system row.
 *
 *   __system__:<event>:<json payload>
 *
 * The payload is JSON (not colon-delimited like the call log) so member
 * names containing ':' - or full email addresses - never corrupt the
 * marker. The frontend `parseSystemMessage` splits on the first two colons
 * and JSON-parses the remainder.
 */
const SYSTEM_MSG_PREFIX = '__system__';
type SystemMsgPayload =
  | { event: 'added'; actor: string; targets: string }
  | { event: 'removed'; target: string; actor: string }
  | { event: 'left'; user: string }
  | { event: 'joined'; user: string }
  | { event: 'created'; actor: string; name: string }
  | { event: 'renamed'; actor: string; from: string; to: string }
  | { event: 'topic'; actor: string; topic: string | null };
function systemMessageContent(payload: SystemMsgPayload): string {
  const { event, ...rest } = payload;
  return `${SYSTEM_MSG_PREFIX}:${event}:${JSON.stringify(rest)}`;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly activeCalls = new Map<string, CallRecord>();
  private readonly callsByRoom = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // Optional so tests / dev sandboxes without NotificationsModule
    // still wire up. When absent, chat works exactly as before - no
    // push fan-out, but no crashes either.
    @Optional() private readonly push?: NotificationsPushService,
    // Optional for the same reason; without it fan-out runs in-process.
    @Optional()
    @InjectQueue(CHAT_FANOUT_QUEUE)
    private readonly fanoutQueue?: Queue<ChatFanoutJobData>,
  ) {}

  /**
   * Authorize an admin-only operation on a chat room.
   *
   * Returns silently if the user is an ADMIN. Throws ForbiddenException
   * otherwise. **Legacy fallback**: rooms that pre-date the role column have
   * every participant stored as MEMBER (no ADMIN rows at all). For those rooms
   * we cannot tell who the admin is, so to keep historical chats functional we
   * allow any member to manage the room until somebody promotes an admin.
   */
  async assertRoomAdmin(userId: string, roomId: string): Promise<void> {
    await this.assertRoomMember(userId, roomId);
    const participants = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId },
      select: { userId: true, role: true },
    });
    const adminCount = participants.filter((p) => p.role === 'ADMIN').length;
    // Legacy room: nobody has an ADMIN row - every member is an admin to keep
    // existing groups manageable.
    if (adminCount === 0) return;
    const self = participants.find((p) => p.userId === userId);
    if (self?.role !== 'ADMIN') {
      throw new ForbiddenException({
        title: 'Admin only',
        status: 403,
        detail: 'Only chat admins can perform this action.',
      });
    }
  }

  async assertRoomMember(userId: string, roomId: string): Promise<void> {
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: {
        id: true,
        type: true,
        isPrivate: true,
        workspace: { select: { organizationId: true } },
        participants: {
          where: { userId },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.participants.length > 0) return;
    // Open channels are accessible to anyone in the same organization (not
    // just one workspace). Private channels require explicit membership,
    // already handled by the participants check above.
    if (
      (room.type === 'TEXT_CHANNEL' || room.type === 'VOICE_CHANNEL') &&
      !room.isPrivate &&
      room.workspace?.organizationId
    ) {
      const myOrgId = await this.getUserOrganizationId(userId);
      if (myOrgId && myOrgId === room.workspace.organizationId) return;
    }
    throw new ForbiddenException({ title: 'Not a member of this room', status: 403 });
  }

  /**
   * People the caller is allowed to start a new chat with. Independent of
   * the workspace switcher - chat is org-wide, not workspace-scoped:
   *
   * Only users in the caller's own organization, for everyone - root-org
   * (Botss) members included - so nobody can enumerate another tenant's
   * people. Users with no `organizationId` see nobody.
   */
  async listContactsForUser(userId: string): Promise<{ items: ChatContact[] }> {
    const me = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    // `accountType: 'STAFF'`: client-portal people are never chat contacts.
    const where = me?.organizationId
      ? {
          deletedAt: null,
          accountType: 'STAFF' as const,
          organizationId: me.organizationId,
          id: { not: userId },
        }
      : // Orphan account (no org). Only chat with yourself, which we exclude
        // - return an empty list rather than leaking unrelated tenants.
        { deletedAt: null, id: '__none__' };

    const rows = await this.prisma.client.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        organization: {
          select: { id: true, name: true, isRoot: true },
        },
      },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 500,
    });

    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        image: r.image,
        organization: r.organization
          ? { id: r.organization.id, name: r.organization.name, isRoot: r.organization.isRoot }
          : null,
      })),
    };
  }

  async listRoomsForUser(
    userId: string,
    // Chat is organization-wide, not workspace-scoped (see listContactsForUser
    // and addParticipants). The active workspace no longer narrows channel
    // discovery; kept in the signature for the controller call site.
    _currentWorkspaceId: string | null,
  ): Promise<{ items: ChatRoomSummary[] }> {
    const [memberships, myOrgId] = await Promise.all([
      this.prisma.client.chatRoomParticipant.findMany({
        where: { userId, room: { deletedAt: null } },
        select: { roomId: true },
      }),
      this.getUserOrganizationId(userId),
    ]);
    const memberRoomIds = new Set(memberships.map((m) => m.roomId));

    const orClauses: Prisma.ChatRoomWhereInput[] = [];
    if (memberRoomIds.size > 0) {
      orClauses.push({ id: { in: Array.from(memberRoomIds) } });
    }
    // Open (non-private) channels are discoverable to everyone in the same
    // organization, regardless of which workspace is active. Private channels
    // only ever surface via explicit membership (the clause above).
    if (myOrgId) {
      orClauses.push({
        type: { in: ['TEXT_CHANNEL', 'VOICE_CHANNEL'] },
        isPrivate: false,
        workspace: { organizationId: myOrgId },
      });
    }
    if (orClauses.length === 0) return { items: [] };

    const rooms = await this.prisma.client.chatRoom.findMany({
      where: { deletedAt: null, OR: orClauses },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true, organizationId: true },
            },
          },
        },
        // Every participant stays: the web client reads the full list off
        // room summaries (member counts, sender names, admin checks, DM peer).
        // The last message is fetched separately below - a nested
        // `messages: { take: 1 }` makes Prisma load every message of every
        // room and slice in memory.
      },
      orderBy: { updatedAt: 'desc' },
    });

    const visibleRoomIds = rooms.map((r) => r.id);

    const [unreadGroups, lastMessages] =
      visibleRoomIds.length > 0
        ? await Promise.all([
            this.prisma.client.chatRoomMessage.groupBy({
              by: ['roomId'],
              where: {
                roomId: { in: visibleRoomIds },
                deletedAt: null,
                status: { in: ['SENT', 'DELIVERED'] },
                senderId: { not: userId },
              },
              _count: { _all: true },
            }),
            this.lastMessagesForRooms(visibleRoomIds),
          ])
        : [[], []];
    const unreadByRoom = new Map<string, number>();
    for (const row of unreadGroups) unreadByRoom.set(row.roomId, row._count._all);
    const lastByRoom = new Map(lastMessages.map((m) => [m.roomId, m]));

    const items: ChatRoomSummary[] = rooms.map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      description: r.description ?? null,
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      createdById: r.createdById ?? null,
      isPrivate: r.isPrivate,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
      participants: r.participants.map((p) => ({
        id: p.id,
        userId: p.userId,
        joinedAt: p.joinedAt,
        role: ((p as { role?: ChatRoomParticipantRole }).role ??
          'MEMBER') as ChatRoomParticipantRole,
        user: {
          id: p.user.id,
          name: p.user.name,
          email: p.user.email,
          image: p.user.image,
        },
      })),
      lastMessage: lastByRoom.has(r.id) ? this.mapMessageRow(lastByRoom.get(r.id)!, userId) : null,
      unreadCount: unreadByRoom.get(r.id) ?? 0,
      spansOrganizations: spansOrganizations(r.type, r.participants),
    }));

    return { items };
  }

  /**
   * The newest live message of each room, with its attachments. One LATERAL
   * lookup per room walks the (roomId, createdAt) index backwards and stops
   * at the first live row, instead of reading every message of every room.
   */
  private async lastMessagesForRooms(roomIds: string[]) {
    const latest = await this.prisma.client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT m."id"
        FROM unnest(${roomIds}::text[]) AS r("roomId")
        CROSS JOIN LATERAL (
          SELECT "id"
            FROM "ChatRoomMessage"
           WHERE "roomId" = r."roomId" AND "deletedAt" IS NULL
           ORDER BY "createdAt" DESC
           LIMIT 1
        ) AS m`);
    if (latest.length === 0) return [];
    return this.prisma.client.chatRoomMessage.findMany({
      where: { id: { in: latest.map((l) => l.id) } },
      include: { attachments: true },
    });
  }

  async listRoomMessages(
    userId: string,
    q: ListRoomMessagesQuery,
  ): Promise<{ items: ChatRoomMessage[]; nextCursor: string | null }> {
    await this.assertRoomMember(userId, q.roomId);
    const where = {
      roomId: q.roomId,
      deletedAt: null,
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
    };
    const rows = await this.prisma.client.chatRoomMessage.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      include: {
        attachments: true,
        reactions: { select: { emoji: true, userId: true } },
        parentMessage: {
          select: {
            id: true,
            senderId: true,
            content: true,
            createdAt: true,
            deletedAt: true,
          },
        },
      },
    });
    const hasMore = rows.length > q.limit;
    const slice = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore ? (slice[slice.length - 1]?.id ?? null) : null;
    const items = slice.map((row) => this.mapMessageRow(row, userId)).reverse();
    return { items, nextCursor };
  }

  /**
   * Peers for a new room: STAFF only (a client-portal account is "not found",
   * so no one can add a client person by id) and in the caller's own org. An
   * org-less caller matches nobody.
   */
  private async assertPeersInMyOrg(userId: string, peers: string[]): Promise<void> {
    const found = await this.prisma.client.user.findMany({
      where: { id: { in: peers }, deletedAt: null, accountType: 'STAFF' },
      select: { id: true, organizationId: true },
    });
    if (found.length !== peers.length) {
      throw new NotFoundException({ title: 'One or more participants not found', status: 404 });
    }
    const myOrgId = await this.getUserOrganizationId(userId);
    const crossOrg = !myOrgId || found.some((u) => u.organizationId !== myOrgId);
    if (crossOrg) {
      throw new ForbiddenException({
        title: 'Cannot chat across organizations',
        status: 403,
      });
    }
  }

  async createRoom(
    userId: string,
    input: CreateChatRoomInput,
    currentWorkspaceId: string | null,
  ): Promise<ChatRoomSummary> {
    const peers = Array.from(new Set(input.participantUserIds ?? []));
    if (peers.includes(userId)) {
      throw new BadRequestException({
        title: 'Cannot include yourself as a participant',
        status: 400,
      });
    }

    if (input.type === 'DM' || input.type === 'GROUP') {
      if (peers.length === 0) {
        throw new BadRequestException({ title: 'No participants provided', status: 400 });
      }
      await this.assertPeersInMyOrg(userId, peers);
      if (input.type === 'DM') {
        const existing = await this.findExistingDm(userId, peers[0]!);
        if (existing) return existing;
      }
      const allIds = Array.from(new Set([userId, ...peers]));
      const room = await this.prisma.client.chatRoom.create({
        data: {
          type: input.type,
          name: input.type === 'GROUP' ? (input.name ?? null) : null,
          description: input.type === 'GROUP' ? (input.description ?? null) : null,
          isPrivate: input.type === 'GROUP' ? true : true,
          createdById: userId,
          participants: {
            createMany: {
              data: allIds.map((uid) => ({
                userId: uid,
                role: uid === userId ? 'ADMIN' : 'MEMBER',
              })),
              skipDuplicates: true,
            },
          },
        },
        include: {
          participants: {
            include: {
              user: { select: { id: true, name: true, email: true, image: true } },
            },
          },
        },
      });
      if (room.type === 'GROUP') {
        await this.announceCreated(room.id, userId, room.name);
      }
      return this.summarizeFreshRoom(room);
    }

    const workspaceId = input.workspaceId ?? currentWorkspaceId;
    if (!workspaceId && !input.projectId) {
      throw new BadRequestException({
        title: 'A workspace is required to create a channel',
        status: 400,
        detail: 'Pick a workspace before creating a channel.',
      });
    }
    if (workspaceId) {
      const ws = await orgWorkspaceMembership(this.prisma, userId, workspaceId);
      if (!ws) {
        throw new ForbiddenException({
          title: 'Not a member of this workspace',
          status: 403,
        });
      }
    }
    if (input.projectId) {
      const project = await this.prisma.client.project.findFirst({
        where: { id: input.projectId, deletedAt: null },
        select: { workspaceId: true },
      });
      if (!project) {
        throw new NotFoundException({ title: 'Project not found', status: 404 });
      }
      if (workspaceId && project.workspaceId !== workspaceId) {
        throw new BadRequestException({
          title: 'Project does not belong to this workspace',
          status: 400,
        });
      }
    }
    if (!input.name) {
      throw new BadRequestException({
        title: 'Channel name is required',
        status: 400,
      });
    }
    if (peers.length > 0) await this.assertPeersInMyOrg(userId, peers);
    const allIds = Array.from(new Set([userId, ...peers]));
    const room = await this.prisma.client.chatRoom.create({
      data: {
        type: input.type,
        name: input.name,
        description: input.description ?? null,
        workspaceId: workspaceId ?? null,
        projectId: input.projectId ?? null,
        createdById: userId,
        isPrivate: input.isPrivate ?? false,
        participants: {
          createMany: {
            data: allIds.map((uid) => ({
              userId: uid,
              role: uid === userId ? 'ADMIN' : 'MEMBER',
            })),
            skipDuplicates: true,
          },
        },
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
      },
    });
    await this.announceCreated(room.id, userId, room.name);
    return this.summarizeFreshRoom(room);
  }

  /** First row of a new group or channel: "Sara created #design". */
  private async announceCreated(
    roomId: string,
    userId: string,
    name: string | null,
  ): Promise<void> {
    const actor = await this.displayName(userId);
    await this.recordSystemMessage(roomId, userId, {
      event: 'created',
      actor,
      name: name?.trim() || 'this conversation',
    });
  }

  private async displayName(userId: string): Promise<string> {
    const u = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return u?.name?.trim() || u?.email || 'Someone';
  }

  private summarizeFreshRoom(room: {
    id: string;
    type: ChatRoomSummary['type'];
    name: string | null;
    description?: string | null;
    workspaceId: string | null;
    projectId: string | null;
    createdById?: string | null;
    isPrivate: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    participants: {
      id: string;
      userId: string;
      joinedAt: Date;
      role?: ChatRoomParticipantRole;
      user: {
        id: string;
        name: string;
        email: string;
        image: string | null;
      };
    }[];
  }): ChatRoomSummary {
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      description: room.description ?? null,
      workspaceId: room.workspaceId,
      projectId: room.projectId,
      createdById: room.createdById ?? null,
      isPrivate: room.isPrivate,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      deletedAt: room.deletedAt,
      participants: room.participants.map((p) => ({
        id: p.id,
        userId: p.userId,
        joinedAt: p.joinedAt,
        role: ((p as { role?: ChatRoomParticipantRole }).role ??
          'MEMBER') as ChatRoomParticipantRole,
        user: {
          id: p.user.id,
          name: p.user.name,
          email: p.user.email,
          image: p.user.image,
        },
      })),
      lastMessage: null,
      unreadCount: 0,
    };
  }

  private async findExistingDm(userA: string, userB: string): Promise<ChatRoomSummary | null> {
    const candidates = await this.prisma.client.chatRoom.findMany({
      // Both users must be in it: the old filter only pinned `userA` and
      // loaded every DM they had, with all participants, to test `userB` in
      // memory. The exact-pair check below still runs on what's left.
      where: {
        type: 'DM',
        deletedAt: null,
        AND: [
          { participants: { some: { userId: userA } } },
          { participants: { some: { userId: userB } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
      },
    });
    for (const c of candidates) {
      const ids = c.participants.map((p) => p.userId);
      if (ids.length === 2 && ids.includes(userB)) {
        return this.summarizeFreshRoom(c);
      }
    }
    return null;
  }

  /**
   * Accept a cross-organization chat request. This is the ONLY path that can
   * put people from two organizations in one DM: `createRoom` and
   * `assertPeersInMyOrg` keep refusing it.
   *
   * The request must be one the recipient can currently see (same filters as
   * the incoming list: addressed to their email, pending, fresh, from a live
   * staff account in another active org they have not blocked); anything
   * else is a 404. The PENDING -> ACCEPTED claim, the DM (reused when the two
   * already have one) and the request's message as its first message are one
   * transaction, so a second accept gets a 409 and creates nothing.
   */
  async openDmFromAcceptedRequest(
    requestId: string,
    recipientUserId: string,
  ): Promise<{
    room: ChatRoomSummary;
    message: ChatRoomMessage;
    requesterId: string;
    /** The accepter's organization name, for the requester's notification. */
    recipientOrganizationName: string | null;
  }> {
    const recipient = await this.prisma.client.user.findFirst({
      where: { id: recipientUserId, deletedAt: null, accountType: 'STAFF' },
      select: {
        id: true,
        email: true,
        organizationId: true,
        createdAt: true,
        organization: { select: { name: true } },
      },
    });
    const notFound = new NotFoundException({ title: 'Chat request not found', status: 404 });
    if (!recipient?.organizationId) throw notFound;
    const now = new Date();
    const request = await this.prisma.client.chatRequest.findFirst({
      where: {
        id: requestId,
        ...incomingRequestWhere(
          {
            id: recipient.id,
            email: recipient.email,
            organizationId: recipient.organizationId,
            createdAt: recipient.createdAt,
          },
          now,
        ),
      },
      select: { id: true, requesterId: true, message: true },
    });
    if (!request) throw notFound;
    const requesterId = request.requesterId;

    const participantInclude = {
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    } as const;

    const { room, message } = await this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.chatRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: 'ACCEPTED', recipientId: recipient.id, respondedAt: now },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          title: 'This chat request was already answered',
          status: 409,
        });
      }
      // Same exact-pair test as findExistingDm, inside the transaction.
      const candidates = await tx.chatRoom.findMany({
        where: {
          type: 'DM',
          deletedAt: null,
          AND: [
            { participants: { some: { userId: requesterId } } },
            { participants: { some: { userId: recipient.id } } },
          ],
        },
        select: { id: true, participants: { select: { userId: true } } },
      });
      const existing = candidates.find((c) => c.participants.length === 2);
      const roomId =
        existing?.id ??
        (
          await tx.chatRoom.create({
            data: {
              type: 'DM',
              name: null,
              description: null,
              isPrivate: true,
              createdById: requesterId,
              participants: {
                createMany: {
                  data: [
                    { userId: requesterId, role: 'ADMIN' },
                    { userId: recipient.id, role: 'MEMBER' },
                  ],
                  skipDuplicates: true,
                },
              },
            },
            select: { id: true },
          })
        ).id;
      const created = await tx.chatRoomMessage.create({
        data: { roomId, senderId: requesterId, content: request.message, status: 'SENT' },
        include: {
          attachments: true,
          reactions: { select: { emoji: true, userId: true } },
          parentMessage: {
            select: { id: true, senderId: true, content: true, createdAt: true, deletedAt: true },
          },
        },
      });
      await tx.chatRequest.update({ where: { id: request.id }, data: { roomId } });
      const touched = await tx.chatRoom.update({
        where: { id: roomId },
        data: { updatedAt: new Date() },
        include: participantInclude,
      });
      return { room: touched, message: created };
    });

    const mapped = this.mapMessageRow(message, recipient.id);
    return {
      room: { ...this.summarizeFreshRoom(room), lastMessage: mapped, spansOrganizations: true },
      message: mapped,
      requesterId,
      recipientOrganizationName: recipient.organization?.name ?? null,
    };
  }

  /**
   * True for a DM or group whose participants are not all in one
   * organization - today only a DM opened from an accepted chat request.
   * Channels are workspace-bound and checked against their workspace's org.
   */
  private async roomSpansOrgs(roomId: string): Promise<boolean> {
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: {
        type: true,
        participants: { select: { user: { select: { organizationId: true } } } },
      },
    });
    return !!room && spansOrganizations(room.type, room.participants);
  }

  /**
   * Does `userId` share a live DM with `peerId` that spans organizations?
   * Gates blocking someone from a DM opened by an accepted chat request.
   */
  async hasCrossOrgDmWith(userId: string, peerId: string): Promise<boolean> {
    if (userId === peerId) return false;
    const rooms = await this.prisma.client.chatRoom.findMany({
      where: {
        type: 'DM',
        deletedAt: null,
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: peerId } } },
        ],
      },
      select: {
        type: true,
        participants: { select: { user: { select: { organizationId: true } } } },
      },
    });
    return rooms.some(
      (r) => r.participants.length === 2 && spansOrganizations(r.type, r.participants),
    );
  }

  /**
   * A cross-organization DM goes quiet - no messages, forwards or calls -
   * once either side blocks the other (from a chat request or from the DM).
   * Same-org rooms are never affected.
   */
  private async assertNotBlockedInCrossOrgDm(userId: string, roomId: string): Promise<void> {
    await assertNotBlockedInCrossOrgDm(this.prisma, userId, roomId);
  }

  /**
   * Attachment URLs arrive from the client, and the web renders them straight
   * into `<img src>` / `<a href>`. Only URLs on our own object storage are
   * accepted; anything else (a tracking pixel on a foreign host, a
   * `javascript:` or `data:` URL) is rejected before it reaches the database.
   */
  private assertOwnStorageUrls(attachments: SendChatMessageInput['attachments']): void {
    if (!attachments || attachments.length === 0) return;
    const prefixes = [
      process.env.S3_PUBLIC_URL,
      process.env.S3_ENDPOINT,
      ...(process.env.CHAT_ATTACHMENT_URL_PREFIXES ?? '').split(','),
    ]
      .map((p) => (p ?? '').trim().replace(/\/+$/, ''))
      .filter((p) => /^https?:\/\//i.test(p));
    for (const a of attachments) {
      let parsed: URL;
      try {
        parsed = new URL(a.fileUrl);
      } catch {
        throw new BadRequestException({ title: 'Invalid attachment URL', status: 400 });
      }
      const href = parsed.toString();
      const allowed =
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        prefixes.some((p) => href.startsWith(`${p}/`));
      if (!allowed) {
        throw new BadRequestException({
          title: 'Attachment must be uploaded through the app',
          status: 400,
        });
      }
    }
  }

  async sendMessage(userId: string, input: SendChatMessageInput): Promise<ChatRoomMessage> {
    await this.assertRoomMember(userId, input.roomId);
    await this.assertNotBlockedInCrossOrgDm(userId, input.roomId);
    this.assertOwnStorageUrls(input.attachments);
    if (input.parentMessageId) {
      const parent = await this.prisma.client.chatRoomMessage.findUnique({
        where: { id: input.parentMessageId },
        select: { roomId: true, deletedAt: true },
      });
      if (!parent || parent.deletedAt || parent.roomId !== input.roomId) {
        throw new BadRequestException({
          title: 'Parent message not found in this room',
          status: 400,
        });
      }
    }
    // Create the message and touch the room in ONE round trip (an array
    // transaction) instead of two sequential awaits.
    const [created] = await this.prisma.client.$transaction([
      this.prisma.client.chatRoomMessage.create({
        data: {
          roomId: input.roomId,
          senderId: userId,
          content: input.content ?? null,
          status: 'SENT',
          parentMessageId: input.parentMessageId ?? null,
          attachments:
            input.attachments && input.attachments.length > 0
              ? {
                  createMany: {
                    data: input.attachments.map((a) => ({
                      fileUrl: a.fileUrl,
                      fileType: a.fileType,
                      fileName: a.fileName,
                      fileSize: a.fileSize,
                    })),
                  },
                }
              : undefined,
        },
        include: {
          attachments: true,
          reactions: { select: { emoji: true, userId: true } },
          parentMessage: {
            select: {
              id: true,
              senderId: true,
              content: true,
              createdAt: true,
              deletedAt: true,
            },
          },
        },
      }),
      this.prisma.client.chatRoom.update({
        where: { id: input.roomId },
        data: { updatedAt: new Date() },
      }),
    ]);
    // Native push + persistent bell rows, off the request path. Never
    // bubbles up to the sender - they already got an HTTP 200 on the message.
    this.dispatchMessageFanout({
      kind: 'message',
      roomId: input.roomId,
      senderUserId: userId,
      content: created.content,
      mentionedUserIds: input.mentionedUserIds ?? [],
      messageId: created.id,
    });
    return this.mapMessageRow(created, userId);
  }

  /**
   * Queue the post-send fan-out on CHAT_FANOUT_QUEUE. If the queue isn't
   * wired (tests, sandboxes) or the enqueue fails, run it in-process exactly
   * as before so no push or bell is lost.
   */
  private dispatchMessageFanout(job: ChatFanoutJobData): void {
    const inline = (): void => {
      void this.runMessageFanout(job);
    };
    if (!this.fanoutQueue) {
      inline();
      return;
    }
    void this.fanoutQueue.add(job.kind, job, CHAT_FANOUT_JOB_OPTIONS).catch((err) => {
      this.logger.warn(
        `Chat fan-out enqueue failed roomId=${job.roomId}, running inline: ${(err as Error)?.message ?? 'unknown'}`,
      );
      inline();
    });
  }

  /**
   * OS push to every other participant AND bell rows for DMs / @mentions,
   * from ONE load of the room, its participants and the sender (each leg used
   * to load them separately). Each leg is isolated: one failing never stops
   * the other, and nothing throws. Called by ChatFanoutProcessor.
   */
  async runMessageFanout(job: ChatFanoutJobData): Promise<void> {
    await this.fanoutMessage(
      job.roomId,
      job.senderUserId,
      job.content,
      job.mentionedUserIds,
      { push: true, bell: true },
      job.messageId,
    );
  }

  /**
   * Persistent bell rows only. Kept for callers (message forwarding) that
   * fan out the two legs separately.
   */
  private async fanoutMessageBell(
    roomId: string,
    senderUserId: string,
    content: string | null,
    mentionedUserIds: string[],
  ): Promise<void> {
    await this.fanoutMessage(roomId, senderUserId, content, mentionedUserIds, {
      push: false,
      bell: true,
    });
  }

  /** OS push only. Kept for callers (message forwarding) that fan out the two legs separately. */
  private async fanoutMessagePush(
    roomId: string,
    senderUserId: string,
    content: string | null,
    messageId?: string,
  ): Promise<void> {
    await this.fanoutMessage(
      roomId,
      senderUserId,
      content,
      [],
      { push: true, bell: false },
      messageId,
    );
  }

  private async fanoutMessage(
    roomId: string,
    senderUserId: string,
    content: string | null,
    mentionedUserIds: string[],
    legs: { push: boolean; bell: boolean },
    messageId?: string,
  ): Promise<void> {
    const wantPush = legs.push && !!this.push;
    if (!wantPush && !legs.bell) return;
    let loaded: Awaited<ReturnType<ChatService['loadFanoutContext']>>;
    try {
      loaded = await this.loadFanoutContext(roomId, senderUserId);
    } catch (err) {
      this.logger.warn(
        `Message fan-out failed roomId=${roomId}: ${(err as Error)?.message ?? 'unknown'}`,
      );
      return;
    }
    const { room, sender } = loaded;
    await Promise.all([
      wantPush
        ? this.pushLeg(roomId, senderUserId, content, room, sender, messageId).catch((err) =>
            this.logger.warn(
              `Message push fan-out failed roomId=${roomId}: ${(err as Error)?.message ?? 'unknown'}`,
            ),
          )
        : undefined,
      legs.bell
        ? this.bellLeg(roomId, senderUserId, content, mentionedUserIds, room, sender).catch((err) =>
            this.logger.warn(
              `Message bell fan-out failed roomId=${roomId}: ${(err as Error)?.message ?? 'unknown'}`,
            ),
          )
        : undefined,
    ]);
  }

  private async loadFanoutContext(roomId: string, senderUserId: string) {
    const [room, sender] = await Promise.all([
      this.prisma.client.chatRoom.findUnique({
        where: { id: roomId },
        select: {
          name: true,
          type: true,
          participants: { select: { userId: true } },
        },
      }),
      this.prisma.client.user.findUnique({
        where: { id: senderUserId },
        select: { name: true, email: true },
      }),
    ]);
    return { room, sender };
  }

  /**
   * Create persistent bell notifications for the subset of chat traffic that
   * deserves to outlive the live session: every DM (notify the other
   * participants) and @mentions in channels/groups (notify the mentioned
   * participants). Regular channel chatter is intentionally NOT bell-worthy -
   * it would flood the bell - but it still raised an OS banner via the push
   * leg. `skipPush: true` here avoids a duplicate banner.
   */
  private async bellLeg(
    roomId: string,
    senderUserId: string,
    content: string | null,
    mentionedUserIds: string[],
    room: { type: string; participants: Array<{ userId: string }> } | null,
    sender: { name: string | null; email: string } | null,
  ): Promise<void> {
    if (!room) return;
    // Fall back to the email (not a generic "Someone") when the user has no
    // display name set, so the recipient can still tell who messaged them.
    const senderName = sender?.name || sender?.email || 'Someone';
    const body = (content ?? '').slice(0, 200) || '[attachment]';
    const participantIds = new Set(room.participants.map((p) => p.userId));

    let recipients: string[];
    let type: 'CHAT_MESSAGE' | 'MENTION';
    let title: string;
    if (room.type === 'DM') {
      recipients = room.participants.map((p) => p.userId).filter((id) => id !== senderUserId);
      type = 'CHAT_MESSAGE';
      title = senderName;
    } else {
      // Only mentioned participants get a bell row in channels/groups.
      recipients = mentionedUserIds.filter((id) => id !== senderUserId && participantIds.has(id));
      type = 'MENTION';
      title = `${senderName} mentioned you`;
    }
    if (recipients.length === 0) return;

    await this.notifications.emitMany(recipients, {
      actorId: senderUserId,
      type,
      title,
      body,
      entityType: 'chat',
      entityId: roomId,
      url: `/chat/${roomId}`,
      pushType: 'message',
      // OS banner already delivered by the push leg.
      skipPush: true,
    });
  }

  /**
   * Compose a Web Push payload for a new chat message and dispatch it to
   * every participant except the sender, with ONE subscription lookup and
   * ONE (chunked) native push request for all of them.
   */
  private async pushLeg(
    roomId: string,
    senderUserId: string,
    content: string | null,
    room: { name: string | null; type: string; participants: Array<{ userId: string }> } | null,
    sender: { name: string | null } | null,
    messageId?: string,
  ): Promise<void> {
    if (!this.push || !room || !sender) return;
    const senderName = sender.name || 'Someone';
    const roomTitle =
      room.type === 'DM'
        ? senderName
        : (room.name ?? (room.type === 'GROUP' ? 'Group chat' : 'Channel'));
    const body = (content ?? '').slice(0, 280) || '[attachment]';
    const targets = room.participants.map((p) => p.userId).filter((id) => id !== senderUserId);
    if (targets.length === 0) return;
    await this.push.sendDesktopNotificationToUsers(targets, {
      // Within desktopPushPayloadSchema's limits: the desktop app validates
      // the payload it gets over the socket.
      title: roomTitle.slice(0, 120),
      body: (room.type === 'DM' ? body : `${senderName}: ${body}`).slice(0, 400),
      type: 'message',
      url: `/chat/${roomId}`,
      tag: `chat:${roomId}`,
      data: { roomId, senderUserId, ...(messageId ? { messageId } : {}) },
    });
  }

  /**
   * Cross-app share. Posts a synthetic message into a target chat room
   * with content `__share__:TYPE:ID:JSON` that the chat-window renders
   * as a structured card.
   *
   * Three checks before we write:
   *   1. The caller is a participant of the target room.
   *   2. The caller can read the source asset (we re-use the read paths
   *      each service uses - projects → tasks, time entries, todos).
   *   3. The target room and the source asset belong to the SAME
   *      organization. If a workspace-scoped room is targeted by a task
   *      from a different org we 404 without leaking existence.
   */
  async shareToChat(
    userId: string,
    targetRoomId: string,
    itemType: ShareToChatItemType,
    itemId: string,
  ): Promise<ChatRoomMessage> {
    // (1) room membership + capture the target's org via its workspace.
    await this.assertRoomMember(userId, targetRoomId);
    const targetRoom = await this.prisma.client.chatRoom.findFirst({
      where: { id: targetRoomId, deletedAt: null },
      select: {
        id: true,
        type: true,
        workspace: { select: { organizationId: true } },
      },
    });
    if (!targetRoom) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    // A DM with someone at another organization (opened from a chat
    // request) never receives cards for this org's records.
    if (await this.roomSpansOrgs(targetRoomId)) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    // Channels are workspace-bound; sharing INTO a channel is fine
    // because the workspace-org check below catches cross-org leakage.

    // (2) + (3) Fetch the asset and a usable card payload. Each branch
    //     bounces on the same NotFoundException so we never confirm or
    //     deny existence across orgs.
    const callerOrgId = await this.getUserOrganizationId(userId);
    const card = await this.buildShareCard(userId, itemType, itemId, callerOrgId);
    const targetOrgId = targetRoom.workspace?.organizationId ?? null;
    // Both the asset and the target room must be in the caller's org.
    // For DMs/Groups (no workspace, no org), we only enforce the asset
    // side - the room is participant-gated which already enforces the
    // boundary because participants share an org by membership rules.
    if (targetOrgId && targetOrgId !== callerOrgId) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }

    const content = `__share__:${card.itemType}:${card.itemId}:${JSON.stringify({
      title: card.title,
      subtitle: card.subtitle ?? null,
      link: card.link,
    })}`;

    const created = await this.prisma.client.chatRoomMessage.create({
      data: {
        roomId: targetRoomId,
        senderId: userId,
        content,
        status: 'SENT',
      },
      include: {
        attachments: true,
        reactions: { select: { emoji: true, userId: true } },
        parentMessage: {
          select: {
            id: true,
            senderId: true,
            content: true,
            createdAt: true,
            deletedAt: true,
          },
        },
      },
    });
    await this.prisma.client.chatRoom.update({
      where: { id: targetRoomId },
      data: { updatedAt: new Date() },
    });
    return this.mapMessageRow(created, userId);
  }

  private async getUserOrganizationId(userId: string): Promise<string | null> {
    const u = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true },
    });
    return u?.organizationId ?? null;
  }

  /**
   * Build a readable card payload for the share endpoint. Each branch
   * verifies the caller can access the asset within their own org's
   * workspaces before returning data - out-of-org assets and assets
   * the caller lacks read on both 404 the same way.
   */
  private async buildShareCard(
    userId: string,
    itemType: ShareToChatItemType,
    itemId: string,
    callerOrgId: string | null,
  ): Promise<ShareCardPayload> {
    const notFound = (): never => {
      throw new NotFoundException({ title: 'Item not found', status: 404 });
    };
    if (!callerOrgId) notFound();
    // After the guard above, callerOrgId is guaranteed non-null. TS does not
    // narrow through the arrow-function `never` return, so we re-bind via
    // a non-null assertion.
    const orgId: string = callerOrgId as string;
    if (itemType === 'task') {
      const task = await this.prisma.client.task.findFirst({
        where: {
          id: itemId,
          deletedAt: null,
          project: { workspace: { organizationId: orgId } },
        },
        select: {
          id: true,
          title: true,
          status: true,
          project: {
            select: {
              id: true,
              name: true,
              workspaceId: true,
              visibility: true,
              createdById: true,
            },
          },
        },
      });
      if (!task) return notFound();
      // Same-org is not enough: the caller must be able to read the task's
      // project (workspace or project membership, and PRIVATE visibility).
      if (!(await this.userCanReadProject(userId, task.project))) return notFound();
      return {
        itemType,
        itemId: task.id,
        title: task.title,
        subtitle: task.project ? `${task.project.name} · ${task.status}` : null,
        link: `/projects/${task.project?.id ?? ''}#task=${task.id}`,
      };
    }
    if (itemType === 'timesheet') {
      const entry = await this.prisma.client.timeEntry.findFirst({
        where: {
          id: itemId,
          deletedAt: null,
          userId,
          workspace: { organizationId: orgId },
        },
        select: {
          id: true,
          description: true,
          durationMin: true,
          startTime: true,
          project: { select: { name: true } },
          projectLabel: true,
        },
      });
      if (!entry) return notFound();
      const project = entry.project?.name ?? entry.projectLabel ?? 'Tracked time';
      const subtitle = `${project} · ${entry.durationMin ?? 0}m`;
      return {
        itemType,
        itemId: entry.id,
        title: entry.description ?? project,
        subtitle,
        link: `/timesheets#entry=${entry.id}`,
      };
    }
    if (itemType === 'todo') {
      const todo = await this.prisma.client.todo.findFirst({
        where: {
          id: itemId,
          deletedAt: null,
          userId,
          workspace: { organizationId: orgId },
        },
        select: { id: true, title: true, done: true, dueDate: true },
      });
      if (!todo) return notFound();
      return {
        itemType,
        itemId: todo.id,
        title: todo.title,
        subtitle: todo.done
          ? 'Done'
          : todo.dueDate
            ? `Due ${todo.dueDate.toISOString().slice(0, 10)}`
            : 'Open',
        link: `/todo#todo=${todo.id}`,
      };
    }
    if (itemType === 'email') {
      // Mailboxes are personal: only a message in one of the CALLER's own
      // mail accounts can be shared (same-org let anyone in the company
      // read a colleague's subject and sender by id).
      const message = await this.prisma.client.mailMessage.findFirst({
        where: {
          id: itemId,
          account: { userId, user: { organizationId: callerOrgId } },
        },
        select: {
          id: true,
          subject: true,
          fromAddress: true,
          fromName: true,
        },
      });
      if (!message) return notFound();
      return {
        itemType,
        itemId: message.id,
        title: message.subject || '(no subject)',
        subtitle: message.fromName
          ? `${message.fromName} <${message.fromAddress}>`
          : message.fromAddress,
        link: `/mail#msg=${message.id}`,
      };
    }
    return notFound();
  }

  /**
   * Project read access for a caller without a request scope: the two gates
   * of `projectAccessWhere` (reachability through workspace or project
   * membership, then PRIVATE visibility via `canSeeProject`), resolved for
   * the project's own workspace.
   */
  private async userCanReadProject(
    userId: string,
    project: { id: string; workspaceId: string; visibility: string; createdById: string },
  ): Promise<boolean> {
    const [wsMembership, projectMembership] = await Promise.all([
      this.prisma.client.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
        select: { id: true },
      }),
      this.prisma.client.projectMembership.findUnique({
        where: { projectId_userId: { projectId: project.id, userId } },
        select: { id: true },
      }),
    ]);
    const eff = await loadEffectivePermissions(userId, project.workspaceId);
    const orgAdmin = eff.company.includes('workspaces.admin_all');
    if (!wsMembership && !projectMembership && !orgAdmin) return false;
    const seesEveryProject = orgAdmin || (wsMembership !== null && isFullWorkspaceAdmin(eff));
    return canSeeProject(
      { userId, projectIds: projectMembership ? [project.id] : [], seesEveryProject },
      project,
    );
  }

  async toggleReaction(
    userId: string,
    messageId: string,
    emoji: string,
  ): Promise<{
    messageId: string;
    roomId: string;
    reactions: ChatReactionTally[];
  }> {
    const message = await this.prisma.client.chatRoomMessage.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { id: true, roomId: true },
    });
    if (!message) {
      throw new NotFoundException({ title: 'Message not found', status: 404 });
    }
    await this.assertRoomMember(userId, message.roomId);
    await this.assertNotBlockedInCrossOrgDm(userId, message.roomId);
    const existing = await this.prisma.client.chatRoomMessageReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.client.chatRoomMessageReaction.delete({
        where: { id: existing.id },
      });
    } else {
      await this.prisma.client.chatRoomMessageReaction.create({
        data: { messageId, userId, emoji },
      });
    }
    const all = await this.prisma.client.chatRoomMessageReaction.findMany({
      where: { messageId },
      select: { emoji: true, userId: true },
    });
    const tally = new Map<string, { count: number; userIds: string[]; reactedByMe: boolean }>();
    for (const r of all) {
      const e = tally.get(r.emoji) ?? {
        count: 0,
        userIds: [] as string[],
        reactedByMe: false,
      };
      e.count += 1;
      e.userIds.push(r.userId);
      if (r.userId === userId) e.reactedByMe = true;
      tally.set(r.emoji, e);
    }
    return {
      messageId,
      roomId: message.roomId,
      reactions: Array.from(tally.entries()).map(([em, t]) => ({
        emoji: em,
        count: t.count,
        userIds: t.userIds,
        reactedByMe: t.reactedByMe,
      })),
    };
  }

  async markDelivered(userId: string, roomId: string): Promise<{ updated: number }> {
    await this.assertRoomMember(userId, roomId);
    const res = await this.prisma.client.chatRoomMessage.updateMany({
      where: {
        roomId,
        senderId: { not: userId },
        status: 'SENT',
        deletedAt: null,
      },
      data: { status: 'DELIVERED' },
    });
    return { updated: res.count };
  }

  async markRead(
    userId: string,
    roomId: string,
    upToMessageId?: string,
  ): Promise<{ updated: number; messageIds: string[] }> {
    await this.assertRoomMember(userId, roomId);
    // Contextual auto-read: opening the room clears its bell notifications
    // regardless of how many messages were marked read below.
    void this.notifications.markReadByEntity(userId, 'chat', roomId).catch(() => {});
    const cutoff = upToMessageId
      ? await this.prisma.client.chatRoomMessage.findUnique({
          where: { id: upToMessageId },
          select: { createdAt: true, roomId: true },
        })
      : null;
    if (upToMessageId && (!cutoff || cutoff.roomId !== roomId)) {
      throw new NotFoundException({ title: 'Cutoff message not found', status: 404 });
    }
    const targets = await this.prisma.client.chatRoomMessage.findMany({
      where: {
        roomId,
        senderId: { not: userId },
        status: { in: ['SENT', 'DELIVERED'] },
        deletedAt: null,
        ...(cutoff ? { createdAt: { lte: cutoff.createdAt } } : {}),
      },
      select: { id: true },
    });
    if (targets.length === 0) return { updated: 0, messageIds: [] };
    const ids = targets.map((t) => t.id);
    await this.prisma.client.chatRoomMessage.updateMany({
      where: { id: { in: ids } },
      data: { status: 'READ' },
    });
    return { updated: ids.length, messageIds: ids };
  }

  async initiateCall(
    callerId: string,
    callerSocketId: string,
    roomId: string,
  ): Promise<{
    call: CallSummary;
    receiverUserIds: string[];
  }> {
    await this.assertRoomMember(callerId, roomId);
    await this.assertNotBlockedInCrossOrgDm(callerId, roomId);
    const existingCallId = this.callsByRoom.get(roomId);
    if (existingCallId) {
      throw new BadRequestException({
        title: 'Another call is in progress in this room',
        status: 400,
      });
    }
    const session = await this.prisma.client.callSession.create({
      data: {
        callerId,
        receiverRoomId: roomId,
        status: 'RINGING',
      },
    });
    const participants = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId },
      select: { userId: true },
    });
    const receiverUserIds = participants.map((p) => p.userId).filter((id) => id !== callerId);

    const record: CallRecord = {
      id: session.id,
      callerId,
      callerSocketId,
      roomId,
      status: 'RINGING',
      startedAt: session.startedAt,
      acceptedByUserIds: new Set(),
      participantIds: new Set(participants.map((p) => p.userId)),
      signalers: new Set([callerId]),
    };
    this.activeCalls.set(session.id, record);
    this.callsByRoom.set(roomId, session.id);

    // Sticky Web Push fan-out - the SW raises `requireInteraction: true`
    // banners so the OS keeps them on-screen until the user dismisses or
    // answers. Fire-and-forget; in-app socket ring still runs in parallel.
    void this.fanoutCallPush(roomId, callerId, session.id, receiverUserIds).catch((err) =>
      this.logger.warn(
        `Call push fan-out failed roomId=${roomId}: ${(err as Error)?.message ?? 'unknown'}`,
      ),
    );

    return {
      call: {
        id: session.id,
        callerId,
        receiverRoomId: roomId,
        status: 'RINGING',
        startedAt: session.startedAt,
        endedAt: null,
      },
      receiverUserIds,
    };
  }

  private async fanoutCallPush(
    roomId: string,
    callerId: string,
    callId: string,
    receiverUserIds: string[],
  ): Promise<void> {
    if (!this.push || receiverUserIds.length === 0) return;
    const caller = await this.prisma.client.user.findUnique({
      where: { id: callerId },
      select: { name: true },
    });
    const callerName = caller?.name || 'Someone';
    await Promise.all(
      receiverUserIds.map((uid) =>
        this.push!.sendDesktopNotification(uid, {
          title: `Incoming call from ${callerName}`.slice(0, 120),
          body: 'Tap to answer.',
          type: 'call',
          url: `/chat/${roomId}?call=${callId}`,
          tag: `call:${roomId}`,
          data: { roomId, callId, callerId },
        }).catch(() => {
          /* per-recipient errors already logged inside the service */
        }),
      ),
    );
  }

  async acceptCall(
    callId: string,
    userId: string,
  ): Promise<{
    call: CallSummary;
    callerId: string;
    callerSocketId: string;
    roomId: string;
  }> {
    const record = this.activeCalls.get(callId);
    if (!record) {
      throw new NotFoundException({ title: 'Call no longer active', status: 404 });
    }
    await this.assertRoomMember(userId, record.roomId);
    record.acceptedByUserIds.add(userId);
    record.signalers.add(userId);
    if (record.status === 'RINGING') {
      record.status = 'ONGOING';
      await this.prisma.client.callSession.update({
        where: { id: callId },
        data: { status: 'ONGOING' },
      });
    }
    return {
      call: {
        id: record.id,
        callerId: record.callerId,
        receiverRoomId: record.roomId,
        status: 'ONGOING',
        startedAt: record.startedAt,
        endedAt: null,
      },
      callerId: record.callerId,
      callerSocketId: record.callerSocketId,
      roomId: record.roomId,
    };
  }

  async rejectCall(
    callId: string,
    userId: string,
  ): Promise<{
    call: CallSummary | null;
    callerId: string | null;
    roomId: string | null;
    callLog: ChatRoomMessage | null;
  }> {
    const record = this.activeCalls.get(callId);
    if (!record) {
      const session = await this.findCallSessionForMember(callId, userId);
      return {
        call: session
          ? {
              id: session.id,
              callerId: session.callerId,
              receiverRoomId: session.receiverRoomId,
              status: session.status,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
            }
          : null,
        callerId: session?.callerId ?? null,
        roomId: session?.receiverRoomId ?? null,
        callLog: null,
      };
    }
    await this.assertRoomMember(userId, record.roomId);
    const session = await this.prisma.client.callSession.update({
      where: { id: callId },
      data: { status: 'REJECTED', endedAt: new Date() },
    });
    this.activeCalls.delete(callId);
    this.callsByRoom.delete(record.roomId);
    const callLog = await this.recordCallLog(record.roomId, record.callerId, 'REJECTED', 0);
    return {
      call: {
        id: session.id,
        callerId: session.callerId,
        receiverRoomId: session.receiverRoomId,
        status: 'REJECTED',
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      },
      callerId: record.callerId,
      roomId: record.roomId,
      callLog,
    };
  }

  async endCall(
    callId: string,
    userId: string,
  ): Promise<{
    call: CallSummary | null;
    participants: string[];
    callLog: ChatRoomMessage | null;
    roomId: string | null;
  }> {
    const record = this.activeCalls.get(callId);
    if (!record) {
      const session = await this.findCallSessionForMember(callId, userId);
      return {
        call: session
          ? {
              id: session.id,
              callerId: session.callerId,
              receiverRoomId: session.receiverRoomId,
              status: session.status,
              startedAt: session.startedAt,
              endedAt: session.endedAt,
            }
          : null,
        participants: [],
        callLog: null,
        roomId: session?.receiverRoomId ?? null,
      };
    }
    await this.assertRoomMember(userId, record.roomId);
    const endedAt = new Date();
    const finalStatus = record.status === 'RINGING' ? 'MISSED' : 'COMPLETED';
    const session = await this.prisma.client.callSession.update({
      where: { id: callId },
      data: { status: finalStatus, endedAt },
    });
    const participantRows = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId: record.roomId },
      select: { userId: true },
    });
    this.activeCalls.delete(callId);
    this.callsByRoom.delete(record.roomId);
    const durationSec =
      finalStatus === 'COMPLETED'
        ? Math.max(0, Math.round((endedAt.getTime() - record.startedAt.getTime()) / 1000))
        : 0;
    const callLog = await this.recordCallLog(
      record.roomId,
      record.callerId,
      finalStatus,
      durationSec,
    );
    return {
      call: {
        id: session.id,
        callerId: session.callerId,
        receiverRoomId: session.receiverRoomId,
        status: finalStatus,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
      },
      participants: participantRows.map((p) => p.userId),
      callLog,
      roomId: record.roomId,
    };
  }

  async getRoomDetail(userId: string, roomId: string): Promise<ChatRoomSummary> {
    await this.assertRoomMember(userId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, name: true, email: true, image: true, organizationId: true },
            },
          },
        },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { attachments: true },
        },
      },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    return {
      id: room.id,
      type: room.type,
      name: room.name,
      description: room.description ?? null,
      workspaceId: room.workspaceId,
      projectId: room.projectId,
      createdById: room.createdById ?? null,
      isPrivate: room.isPrivate,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      deletedAt: room.deletedAt,
      participants: room.participants.map((p) => ({
        id: p.id,
        userId: p.userId,
        joinedAt: p.joinedAt,
        role: ((p as { role?: ChatRoomParticipantRole }).role ??
          'MEMBER') as ChatRoomParticipantRole,
        user: {
          id: p.user.id,
          name: p.user.name,
          email: p.user.email,
          image: p.user.image,
        },
      })),
      lastMessage: room.messages[0] ? this.mapMessageRow(room.messages[0]) : null,
      unreadCount: 0,
      spansOrganizations: spansOrganizations(room.type, room.participants),
    };
  }

  async addParticipants(
    userId: string,
    roomId: string,
    userIds: string[],
  ): Promise<{ added: number; systemMessage: ChatRoomMessage | null }> {
    await this.assertRoomAdmin(userId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true, workspaceId: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Cannot add members to a direct message',
        status: 400,
      });
    }
    const ids = Array.from(new Set(userIds)).filter((id) => id !== userId);
    if (ids.length === 0) return { added: 0, systemMessage: null };

    // Channels and groups are org-scoped, not workspace-scoped: any user in
    // the acting user's organisation may be added, regardless of whether they
    // belong to the channel's workspace. We still enforce the org wall (and
    // that the users exist) so a channel can't pull in someone from another
    // tenant - mirroring the DM/GROUP create path and the org-scoped contacts
    // list, with no exception for root-org members.
    // Staff only, as on DM create: client-portal accounts cannot be added.
    const candidates = await this.prisma.client.user.findMany({
      where: { id: { in: ids }, deletedAt: null, accountType: 'STAFF' },
      select: { id: true, organizationId: true },
    });
    if (candidates.length !== ids.length) {
      throw new NotFoundException({
        title: 'One or more users not found',
        status: 404,
      });
    }
    const myOrgId = await this.getUserOrganizationId(userId);
    const crossOrg = !myOrgId || candidates.some((u) => u.organizationId !== myOrgId);
    if (crossOrg) {
      throw new ForbiddenException({
        title: 'Cannot add users from another organization',
        status: 403,
      });
    }
    const result = await this.prisma.client.chatRoomParticipant.createMany({
      data: ids.map((uid) => ({ roomId, userId: uid })),
      skipDuplicates: true,
    });

    // Announce the membership change as a centered system row. Best-effort:
    // a logging failure must never fail the add itself.
    let systemMessage: ChatRoomMessage | null = null;
    if (result.count > 0) {
      const people = await this.prisma.client.user.findMany({
        where: { id: { in: [userId, ...ids] } },
        select: { id: true, name: true, email: true },
      });
      const nameOf = (id: string): string => {
        const u = people.find((p) => p.id === id);
        return u?.name?.trim() || u?.email || 'Someone';
      };
      systemMessage = await this.recordSystemMessage(roomId, userId, {
        event: 'added',
        actor: nameOf(userId),
        targets: ids.map(nameOf).join(', '),
      });
    }
    return { added: result.count, systemMessage };
  }

  async removeParticipant(
    actingUserId: string,
    roomId: string,
    targetUserId: string,
  ): Promise<{ ok: true; systemMessage: ChatRoomMessage | null }> {
    await this.assertRoomAdmin(actingUserId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true, createdById: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Cannot remove members from a direct message',
        status: 400,
      });
    }
    if (targetUserId === actingUserId) {
      throw new BadRequestException({
        title: 'Use leave instead of removing yourself',
        status: 400,
      });
    }
    // Only an actual member can be removed. Without this the system message
    // below would put any user's name, from any org, into the room.
    const member = await this.prisma.client.chatRoomParticipant.findFirst({
      where: { roomId, userId: targetUserId },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundException({ title: 'Not a member of this chat', status: 404 });
    }
    if (room.createdById && room.createdById === targetUserId) {
      throw new ForbiddenException({
        title: 'Cannot remove the creator',
        status: 403,
        detail: 'The creator of this chat cannot be removed.',
      });
    }
    // Record the system message BEFORE the delete, while both users still
    // resolve, and author it as the actor so it stays visible to the
    // remaining members (the removed user drops out of the room socket once
    // the delete lands, so they won't see it - same as Slack).
    const people = await this.prisma.client.user.findMany({
      where: { id: { in: [actingUserId, targetUserId] } },
      select: { id: true, name: true, email: true },
    });
    const nameOf = (id: string): string => {
      const u = people.find((p) => p.id === id);
      return u?.name?.trim() || u?.email || 'Someone';
    };
    const systemMessage = await this.recordSystemMessage(roomId, actingUserId, {
      event: 'removed',
      target: nameOf(targetUserId),
      actor: nameOf(actingUserId),
    });

    // An admin may not boot another admin unless the target is *not* the
    // creator. The creator check above already blocked the only protected
    // case, so an admin-acting-on-admin removal proceeds.
    await this.prisma.client.chatRoomParticipant.deleteMany({
      where: { roomId, userId: targetUserId },
    });
    return { ok: true, systemMessage };
  }

  async updateParticipantRole(
    actingUserId: string,
    roomId: string,
    targetUserId: string,
    role: ChatRoomParticipantRole,
  ): Promise<{ ok: true; role: ChatRoomParticipantRole }> {
    await this.assertRoomAdmin(actingUserId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true, createdById: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Direct messages do not have roles',
        status: 400,
      });
    }
    if (room.createdById && room.createdById === targetUserId && role !== 'ADMIN') {
      throw new ForbiddenException({
        title: 'Creator must remain admin',
        status: 403,
        detail: 'The chat creator cannot be demoted.',
      });
    }
    const existing = await this.prisma.client.chatRoomParticipant.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({
        title: 'Participant not found',
        status: 404,
      });
    }
    await this.prisma.client.chatRoomParticipant.update({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      data: { role },
    });
    return { ok: true, role };
  }

  async leaveRoom(
    userId: string,
    roomId: string,
  ): Promise<{ ok: true; systemMessage: ChatRoomMessage | null }> {
    await this.assertRoomMember(userId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Cannot leave a direct message',
        status: 400,
      });
    }
    // If the leaver is the only admin and other members remain, hand the
    // crown to the oldest member so the room never becomes orphaned. Runs in
    // a single transaction so the leave + promote happen atomically.
    const participants = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId },
      orderBy: { joinedAt: 'asc' },
      select: { userId: true, role: true, joinedAt: true },
    });
    const self = participants.find((p) => p.userId === userId);
    const others = participants.filter((p) => p.userId !== userId);
    const otherAdminExists = others.some((p) => p.role === 'ADMIN');
    const successor =
      self?.role === 'ADMIN' && !otherAdminExists && others.length > 0 ? others[0] : null;

    // Record the "left" system message before the leaver drops out of the
    // room, authored by the leaver so it threads correctly. Best-effort.
    const me = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const systemMessage = await this.recordSystemMessage(roomId, userId, {
      event: 'left',
      user: me?.name?.trim() || me?.email || 'Someone',
    });

    await this.prisma.client.$transaction(async (tx) => {
      await tx.chatRoomParticipant.deleteMany({ where: { roomId, userId } });
      if (successor) {
        await tx.chatRoomParticipant.update({
          where: {
            roomId_userId: { roomId, userId: successor.userId },
          },
          data: { role: 'ADMIN' },
        });
      }
    });
    return { ok: true, systemMessage };
  }

  /**
   * Update a room and post "renamed" / "changed the topic" rows for the
   * changes that people in the room should see. The caller broadcasts
   * `systemMessages` so the rows appear live.
   */
  async updateRoomWithEvents(
    userId: string,
    roomId: string,
    input: { name?: string; description?: string | null; isPrivate?: boolean },
  ): Promise<{ room: ChatRoomSummary; systemMessages: ChatRoomMessage[] }> {
    await this.assertRoomAdmin(userId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true, name: true, description: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Cannot edit a direct message',
        status: 400,
      });
    }
    const data: { name?: string; description?: string | null; isPrivate?: boolean } = {};
    if (input.isPrivate !== undefined) {
      if (room.type !== 'TEXT_CHANNEL' && room.type !== 'VOICE_CHANNEL') {
        throw new BadRequestException({
          title: 'Only channels have a visibility setting',
          status: 400,
        });
      }
      // Flipping a channel to private restricts it to its current participant
      // list (creator + everyone explicitly added). Org members who could see
      // it only because it was open lose access - that's the intended effect.
      // No participant rows are removed, so flipping back to open restores the
      // previous reach.
      data.isPrivate = input.isPrivate;
    }
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (trimmed.length === 0 || trimmed.length > 80) {
        throw new BadRequestException({
          title: 'Name must be 1-80 characters',
          status: 400,
        });
      }
      data.name = trimmed;
    }
    if (input.description !== undefined) {
      const trimmed = input.description?.trim() ?? null;
      if (trimmed !== null && trimmed.length > 500) {
        throw new BadRequestException({
          title: 'Description must be 500 characters or fewer',
          status: 400,
        });
      }
      data.description = trimmed === '' ? null : trimmed;
    }
    if (Object.keys(data).length === 0) {
      return { room: await this.getRoomDetail(userId, roomId), systemMessages: [] };
    }
    await this.prisma.client.chatRoom.update({
      where: { id: roomId },
      data,
    });

    const systemMessages: ChatRoomMessage[] = [];
    const renamed = data.name !== undefined && data.name !== (room.name ?? '');
    const topicChanged =
      data.description !== undefined && (data.description ?? null) !== (room.description ?? null);
    if (renamed || topicChanged) {
      const actor = await this.displayName(userId);
      if (renamed) {
        const msg = await this.recordSystemMessage(roomId, userId, {
          event: 'renamed',
          actor,
          from: room.name?.trim() || 'Untitled',
          to: data.name!,
        });
        if (msg) systemMessages.push(msg);
      }
      if (topicChanged) {
        const msg = await this.recordSystemMessage(roomId, userId, {
          event: 'topic',
          actor,
          topic: data.description ?? null,
        });
        if (msg) systemMessages.push(msg);
      }
    }
    return { room: await this.getRoomDetail(userId, roomId), systemMessages };
  }

  async createInvite(
    userId: string,
    roomId: string,
    input: CreateInviteInput,
  ): Promise<ChatRoomInvite> {
    await this.assertRoomAdmin(userId, roomId);
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    if (room.type === 'DM') {
      throw new BadRequestException({
        title: 'Direct messages do not support invite links',
        status: 400,
      });
    }
    const code = generateInviteCode();
    const expiresAt = input.expiresInHours
      ? new Date(Date.now() + input.expiresInHours * 60 * 60 * 1000)
      : null;
    const created = await this.prisma.client.chatRoomInvite.create({
      data: {
        roomId,
        code,
        createdById: userId,
        maxUses: input.maxUses ?? null,
        expiresAt,
      },
    });
    return {
      id: created.id,
      roomId: created.roomId,
      code: created.code,
      createdById: created.createdById,
      maxUses: created.maxUses,
      usedCount: created.usedCount,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    };
  }

  async previewInvite(userId: string, code: string): Promise<InvitePreview> {
    const invite = await this.findActiveInvite(code);
    const [participants, alreadyJoined] = await Promise.all([
      this.prisma.client.chatRoomParticipant.count({
        where: { roomId: invite.roomId },
      }),
      this.prisma.client.chatRoomParticipant.findUnique({
        where: { roomId_userId: { roomId: invite.roomId, userId } },
        select: { id: true },
      }),
    ]);
    const now = Date.now();
    const expired = invite.expiresAt ? invite.expiresAt.getTime() < now : false;
    const exhausted = invite.maxUses ? invite.usedCount >= invite.maxUses : false;
    return {
      code: invite.code,
      room: {
        id: invite.room.id,
        name: invite.room.name,
        type: invite.room.type,
        participantCount: participants,
      },
      invitedBy: {
        id: invite.createdBy.id,
        name: invite.createdBy.name,
        email: invite.createdBy.email,
        image: invite.createdBy.image,
      },
      expired,
      exhausted,
      alreadyJoined: !!alreadyJoined,
    };
  }

  async acceptInvite(
    userId: string,
    code: string,
  ): Promise<{ roomId: string; alreadyJoined: boolean; systemMessage: ChatRoomMessage | null }> {
    const invite = await this.findActiveInvite(code);
    const now = Date.now();
    if (invite.expiresAt && invite.expiresAt.getTime() < now) {
      throw new BadRequestException({ title: 'Invite expired', status: 400 });
    }
    // Early, friendly rejection. The authoritative cap check is the atomic
    // conditional increment inside the transaction below.
    if (invite.maxUses && invite.usedCount >= invite.maxUses) {
      throw new BadRequestException({ title: 'Invite reached its usage cap', status: 400 });
    }
    if (invite.room.workspaceId) {
      const ws = await orgWorkspaceMembership(this.prisma, userId, invite.room.workspaceId);
      if (!ws) {
        throw new ForbiddenException({
          title: 'You must be a workspace member to accept this invite',
          status: 403,
        });
      }
    }
    const existing = await this.prisma.client.chatRoomParticipant.findUnique({
      where: { roomId_userId: { roomId: invite.roomId, userId } },
      select: { id: true },
    });
    if (existing) {
      return { roomId: invite.roomId, alreadyJoined: true, systemMessage: null };
    }
    // Claim a use atomically. Read-then-increment let N concurrent accepts on
    // a single-use invite all pass the check above and all join a private
    // room. The conditional updateMany only matches while a use is left.
    await this.prisma.client.$transaction(async (tx) => {
      const claimed = await tx.chatRoomInvite.updateMany({
        where: {
          id: invite.id,
          ...(invite.maxUses ? { usedCount: { lt: invite.maxUses } } : {}),
        },
        data: { usedCount: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new BadRequestException({ title: 'Invite reached its usage cap', status: 400 });
      }
      await tx.chatRoomParticipant.create({
        data: { roomId: invite.roomId, userId },
      });
    });
    // Every path that adds someone to a room announces it. Invite-link joins
    // used to be silent, so members never saw who had come in.
    const systemMessage = await this.recordSystemMessage(invite.roomId, userId, {
      event: 'joined',
      user: await this.displayName(userId),
    });
    return { roomId: invite.roomId, alreadyJoined: false, systemMessage };
  }

  private async findActiveInvite(code: string) {
    const invite = await this.prisma.client.chatRoomInvite.findFirst({
      where: { code, deletedAt: null },
      include: {
        room: {
          select: { id: true, name: true, type: true, workspaceId: true, deletedAt: true },
        },
        createdBy: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    });
    if (!invite || invite.room.deletedAt) {
      throw new NotFoundException({ title: 'Invite not found', status: 404 });
    }
    return invite;
  }

  /**
   * Admin room listing, clamped to the actor's organization.
   *
   * The previous filter ORed the workspace with unconditional `type: 'DM'` and
   * `type: 'GROUP'`, so a tenant ADMIN received every DM and group on the
   * whole platform, with participant emails and last message bodies. Now a
   * room is visible when it belongs to the active workspace, or when it has no
   * workspace (DMs, groups) and at least one participant is in the actor's
   * organization. SUPER_ADMIN gets exactly the same view: a platform
   * operator never sees other organizations' conversations.
   */
  async listAdminRoomsForWorkspace(
    workspaceId: string,
    actor: { systemRole: string; organizationId: string | null },
  ): Promise<{ items: ChatRoomSummary[] }> {
    const orgId = actor.organizationId ?? '__none__';
    const rooms = await this.prisma.client.chatRoom.findMany({
      where: {
        deletedAt: null,
        OR: [
          { workspaceId, workspace: { organizationId: orgId } },
          {
            workspaceId: null,
            type: { in: ['DM', 'GROUP'] },
            participants: { some: { user: { organizationId: orgId } } },
            // Every participant must be ours: a DM opened from a chat request
            // (someone at another org) is never in an admin's view. Spelled
            // out with an explicit null branch because `not: orgId` alone
            // skips NULL (an org-less or client account is "not ours" too).
            NOT: {
              participants: {
                some: {
                  user: { OR: [{ organizationId: null }, { organizationId: { not: orgId } }] },
                },
              },
            },
          },
        ],
      },
      include: {
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { attachments: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return {
      items: rooms.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        description: r.description ?? null,
        workspaceId: r.workspaceId,
        projectId: r.projectId,
        createdById: r.createdById ?? null,
        isPrivate: r.isPrivate,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
        participants: r.participants.map((p) => ({
          id: p.id,
          userId: p.userId,
          joinedAt: p.joinedAt,
          role: ((p as { role?: ChatRoomParticipantRole }).role ??
            'MEMBER') as ChatRoomParticipantRole,
          user: {
            id: p.user.id,
            name: p.user.name,
            email: p.user.email,
            image: p.user.image,
          },
        })),
        lastMessage: r.messages[0] ? this.mapMessageRow(r.messages[0]) : null,
        unreadCount: 0,
      })),
    };
  }

  async adminDeleteRoom(
    roomId: string,
    actor: { systemRole: string; organizationId: string | null },
  ): Promise<{ ok: true }> {
    const room = await this.prisma.client.chatRoom.findFirst({
      where: { id: roomId, deletedAt: null },
      select: {
        id: true,
        workspace: { select: { organizationId: true } },
        participants: { select: { user: { select: { organizationId: true } } } },
      },
    });
    if (!room) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    // Same tenant clamp as the listing. A room from another organization is
    // reported as not found rather than forbidden so ids cannot be probed.
    // No SUPER_ADMIN exception. A workspace-less room (DM / group) is ours
    // only when EVERY participant is: admin tools never reach a DM spanning
    // two organizations.
    const orgId = actor.organizationId;
    const inOrg = room.workspace
      ? room.workspace.organizationId === orgId
      : room.participants.length > 0 &&
        room.participants.every((p) => p.user.organizationId === orgId);
    if (!orgId || !inOrg) {
      throw new NotFoundException({ title: 'Chat room not found', status: 404 });
    }
    await this.prisma.client.chatRoom.update({
      where: { id: roomId },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  async dropCallsForSocket(socketId: string): Promise<
    {
      callId: string;
      roomId: string;
      participants: string[];
      callLog: ChatRoomMessage | null;
    }[]
  > {
    const closed: {
      callId: string;
      roomId: string;
      participants: string[];
      callLog: ChatRoomMessage | null;
    }[] = [];
    for (const [callId, record] of Array.from(this.activeCalls.entries())) {
      if (record.callerSocketId !== socketId) continue;
      const participantRows = await this.prisma.client.chatRoomParticipant.findMany({
        where: { roomId: record.roomId },
        select: { userId: true },
      });
      const endedAt = new Date();
      const finalStatus = record.status === 'RINGING' ? 'MISSED' : 'COMPLETED';
      await this.prisma.client.callSession
        .update({
          where: { id: callId },
          data: { status: finalStatus, endedAt },
        })
        .catch(() => {});
      this.activeCalls.delete(callId);
      this.callsByRoom.delete(record.roomId);
      const durationSec =
        finalStatus === 'COMPLETED'
          ? Math.max(0, Math.round((endedAt.getTime() - record.startedAt.getTime()) / 1000))
          : 0;
      const callLog = await this.recordCallLog(
        record.roomId,
        record.callerId,
        finalStatus,
        durationSec,
      );
      closed.push({
        callId,
        roomId: record.roomId,
        participants: participantRows.map((p) => p.userId),
        callLog,
      });
    }
    return closed;
  }

  /**
   * Authorize one WebRTC signaling hop (offer, answer or ICE candidate).
   *
   * The sender must be a member of the call's room (checked against the DB
   * once per user per call, then cached on the record so ICE stays cheap), and
   * the target must be someone actually in the call - the caller, an accepter
   * or a room participant. Without the target check any member could relay
   * signaling at an arbitrary user id outside the room.
   */
  async assertCallSignal(callId: string, fromUserId: string, toUserId: string): Promise<string> {
    const record = this.activeCalls.get(callId);
    if (!record) {
      throw new NotFoundException({ title: 'Call no longer active', status: 404 });
    }
    if (!record.signalers.has(fromUserId)) {
      await this.assertRoomMember(fromUserId, record.roomId);
      record.signalers.add(fromUserId);
    }
    const targetInCall =
      toUserId === record.callerId ||
      record.acceptedByUserIds.has(toUserId) ||
      record.participantIds.has(toUserId);
    if (!targetInCall) {
      throw new ForbiddenException({
        title: 'Target is not in this call',
        status: 403,
      });
    }
    return record.roomId;
  }

  /**
   * Load a finished call's session row, but only for a member of its room.
   * The reject/end handlers fall back to this when the call is no longer in
   * memory; returning the row to a non-member let anyone replay a callId and
   * make the gateway emit spoofed `call_rejected` events at a stranger.
   */
  private async findCallSessionForMember(callId: string, userId: string) {
    const session = await this.prisma.client.callSession
      .findUnique({ where: { id: callId } })
      .catch(() => null);
    if (!session) return null;
    try {
      await this.assertRoomMember(userId, session.receiverRoomId);
    } catch {
      return null;
    }
    return session;
  }

  async forceEndCallByRoom(roomId: string): Promise<{
    callId: string | null;
    callLog: ChatRoomMessage | null;
    participants: string[];
  }> {
    const callId = this.callsByRoom.get(roomId);
    if (!callId) return { callId: null, callLog: null, participants: [] };
    const record = this.activeCalls.get(callId);
    this.activeCalls.delete(callId);
    this.callsByRoom.delete(roomId);
    const endedAt = new Date();
    const finalStatus = record?.status === 'RINGING' ? 'MISSED' : 'COMPLETED';
    await this.prisma.client.callSession
      .update({
        where: { id: callId },
        data: { status: finalStatus, endedAt },
      })
      .catch(() => {});
    const participantRows = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId },
      select: { userId: true },
    });
    const durationSec =
      record && finalStatus === 'COMPLETED'
        ? Math.max(0, Math.round((endedAt.getTime() - record.startedAt.getTime()) / 1000))
        : 0;
    const callLog = record
      ? await this.recordCallLog(roomId, record.callerId, finalStatus, durationSec)
      : null;
    return {
      callId,
      callLog,
      participants: participantRows.map((p) => p.userId),
    };
  }

  /**
   * Writes a synthetic ChatRoomMessage to the room representing the outcome
   * of a call. Other clients pick it up via the same `msg_received` /
   * `room_bumped` channels as regular messages, so the call log appears in
   * the conversation in real time. The content uses the `__call__` marker
   * prefix recognized by the chat-window renderer.
   */
  private async recordCallLog(
    roomId: string,
    callerId: string,
    status: 'COMPLETED' | 'MISSED' | 'REJECTED',
    durationSec: number,
  ): Promise<ChatRoomMessage | null> {
    try {
      const created = await this.prisma.client.chatRoomMessage.create({
        data: {
          roomId,
          senderId: callerId,
          content: callLogContent(status, durationSec),
          status: 'SENT',
        },
        include: {
          attachments: true,
          reactions: { select: { emoji: true, userId: true } },
          parentMessage: {
            select: {
              id: true,
              senderId: true,
              content: true,
              createdAt: true,
              deletedAt: true,
            },
          },
        },
      });
      await this.prisma.client.chatRoom.update({
        where: { id: roomId },
        data: { updatedAt: new Date() },
      });
      return this.mapMessageRow(created);
    } catch (err) {
      this.logger.warn(
        `recordCallLog failed roomId=${roomId} status=${status} err=${(err as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
  }

  /**
   * Writes a synthetic membership-change message ("X added Y", "X left", "X
   * removed Y") to the room. Mirrors {@link recordCallLog}: same create +
   * mapMessageRow path so it rides the normal `msg_received` / `room_bumped`
   * broadcast and appears in the conversation in real time. The content uses
   * the `__system__` marker recognized by the chat-window renderer. Best
   * effort - returns null on failure so the membership mutation never fails
   * just because the announcement couldn't be written.
   */
  private async recordSystemMessage(
    roomId: string,
    authorId: string,
    payload: SystemMsgPayload,
  ): Promise<ChatRoomMessage | null> {
    try {
      const created = await this.prisma.client.chatRoomMessage.create({
        data: {
          roomId,
          senderId: authorId,
          content: systemMessageContent(payload),
          status: 'SENT',
        },
        include: {
          attachments: true,
          reactions: { select: { emoji: true, userId: true } },
        },
      });
      await this.prisma.client.chatRoom.update({
        where: { id: roomId },
        data: { updatedAt: new Date() },
      });
      return this.mapMessageRow(created);
    } catch (err) {
      this.logger.warn(
        `recordSystemMessage failed roomId=${roomId} event=${payload.event} err=${(err as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
  }

  /**
   * Soft-delete a single message. Permitted to the sender or any room admin.
   * Returns the room ID so the gateway can broadcast a purge event.
   */
  async deleteMessage(
    userId: string,
    messageId: string,
  ): Promise<{ roomId: string; messageId: string }> {
    const message = await this.prisma.client.chatRoomMessage.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { id: true, roomId: true, senderId: true },
    });
    if (!message) {
      throw new NotFoundException({ title: 'Message not found', status: 404 });
    }
    if (message.senderId !== userId) {
      // Non-senders need to be room admins to delete other people's content.
      await this.assertRoomAdmin(userId, message.roomId);
      // The requester is ADMIN of a DM opened from a chat request; that must
      // not let them delete what someone at another organization wrote.
      if (await this.roomSpansOrgs(message.roomId)) {
        throw new ForbiddenException({
          title: 'You can only delete your own messages here',
          status: 403,
        });
      }
    } else {
      await this.assertRoomMember(userId, message.roomId);
    }
    await this.prisma.client.chatRoomMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
    return { roomId: message.roomId, messageId };
  }

  /**
   * Edit a message body. Sender-only (no admin override - admins can delete,
   * not rewrite someone else's words). Sets `editedAt` so the UI can show an
   * "(edited)" marker. Attachments are immutable here.
   */
  async editMessage(userId: string, messageId: string, content: string): Promise<ChatRoomMessage> {
    const message = await this.prisma.client.chatRoomMessage.findFirst({
      where: { id: messageId, deletedAt: null },
      select: { id: true, roomId: true, senderId: true },
    });
    if (!message) {
      throw new NotFoundException({ title: 'Message not found', status: 404 });
    }
    if (message.senderId !== userId) {
      throw new ForbiddenException({
        title: 'You can only edit your own messages',
        status: 403,
      });
    }
    await this.assertRoomMember(userId, message.roomId);
    await this.assertNotBlockedInCrossOrgDm(userId, message.roomId);
    const updated = await this.prisma.client.chatRoomMessage.update({
      where: { id: messageId },
      data: { content, editedAt: new Date() },
      include: {
        attachments: true,
        reactions: { select: { emoji: true, userId: true } },
        parentMessage: {
          select: {
            id: true,
            senderId: true,
            content: true,
            createdAt: true,
            deletedAt: true,
          },
        },
      },
    });
    return this.mapMessageRow(updated, userId);
  }

  /**
   * Forward existing messages into another room. Each forwarded message is
   * re-created as a plain new message authored by the forwarder (no
   * "forwarded" marker, per product decision) - text and attachments are
   * copied. The caller must be a member of the target room AND of every room
   * the source messages live in, so this can't be used to exfiltrate messages
   * from rooms the caller can't see.
   */
  async forwardMessages(
    userId: string,
    messageIds: string[],
    targetRoomId: string,
  ): Promise<ChatRoomMessage[]> {
    await this.assertRoomMember(userId, targetRoomId);
    await this.assertNotBlockedInCrossOrgDm(userId, targetRoomId);
    const sources = await this.prisma.client.chatRoomMessage.findMany({
      where: { id: { in: messageIds }, deletedAt: null },
      select: {
        id: true,
        roomId: true,
        content: true,
        attachments: {
          select: { fileUrl: true, fileType: true, fileName: true, fileSize: true },
        },
      },
    });
    if (sources.length === 0) {
      throw new NotFoundException({ title: 'No messages to forward', status: 404 });
    }
    // Membership check on every distinct source room.
    const sourceRoomIds = Array.from(new Set(sources.map((s) => s.roomId)));
    for (const rid of sourceRoomIds) {
      await this.assertRoomMember(userId, rid);
    }
    // Messages from this org's rooms never cross into a DM with another
    // organization; re-forwarding inside that same DM is fine.
    if (
      sourceRoomIds.some((rid) => rid !== targetRoomId) &&
      (await this.roomSpansOrgs(targetRoomId))
    ) {
      throw new ForbiddenException({
        title: "Can't forward into a chat with another organization",
        status: 403,
      });
    }
    // Preserve the order the caller selected the messages in.
    const byId = new Map(sources.map((s) => [s.id, s]));
    const ordered = messageIds
      .map((id) => byId.get(id))
      .filter((s): s is NonNullable<typeof s> => !!s);

    // All creates go out as one batched transaction instead of one awaited
    // round-trip per message (nested attachment writes + includes rule out
    // createManyAndReturn). createdAt is stamped explicitly,
    // 1 ms apart, so the forwarded messages keep the caller's order in the
    // (createdAt, id) timeline - inside a single batch the default now() could
    // collide, and cuid ids don't sort by insertion.
    const baseMs = Date.now();
    const creates = ordered.map((src, i) =>
      this.prisma.client.chatRoomMessage.create({
        data: {
          roomId: targetRoomId,
          senderId: userId,
          content: src.content,
          status: 'SENT',
          createdAt: new Date(baseMs + i),
          attachments:
            src.attachments.length > 0
              ? {
                  createMany: {
                    data: src.attachments.map((a) => ({
                      fileUrl: a.fileUrl,
                      fileType: a.fileType,
                      fileName: a.fileName,
                      fileSize: a.fileSize,
                    })),
                  },
                }
              : undefined,
        },
        include: {
          attachments: true,
          reactions: { select: { emoji: true, userId: true } },
          parentMessage: {
            select: {
              id: true,
              senderId: true,
              content: true,
              createdAt: true,
              deletedAt: true,
            },
          },
        },
      }),
    );
    const rows = await this.prisma.client.$transaction(creates);
    const created: ChatRoomMessage[] = rows.map((row) => this.mapMessageRow(row, userId));
    await this.prisma.client.chatRoom.update({
      where: { id: targetRoomId },
      data: { updatedAt: new Date() },
    });
    // Single push/bell fan-out for the batch so a 20-message forward doesn't
    // fire 20 banners. Use the last message's content as the preview.
    const lastContent = ordered[ordered.length - 1]?.content ?? null;
    const lastId = created[created.length - 1]?.id;
    void this.fanoutMessagePush(targetRoomId, userId, lastContent, lastId).catch((err) =>
      this.logger.warn(
        `Forward push fan-out failed roomId=${targetRoomId}: ${(err as Error)?.message ?? 'unknown'}`,
      ),
    );
    void this.fanoutMessageBell(targetRoomId, userId, lastContent, []).catch((err) =>
      this.logger.warn(
        `Forward bell fan-out failed roomId=${targetRoomId}: ${(err as Error)?.message ?? 'unknown'}`,
      ),
    );
    return created;
  }

  /**
   * Soft-delete every message in a room. Admin only.
   * Returns the count and the room ID so the gateway can broadcast a purge.
   */
  async deleteAllRoomMessages(
    userId: string,
    roomId: string,
  ): Promise<{ roomId: string; cleared: number }> {
    await this.assertRoomAdmin(userId, roomId);
    // Nobody wipes the other organization's side of a cross-org DM.
    if (await this.roomSpansOrgs(roomId)) {
      throw new ForbiddenException({
        title: "Can't clear a chat with another organization",
        status: 403,
      });
    }
    const result = await this.prisma.client.chatRoomMessage.updateMany({
      where: { roomId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    return { roomId, cleared: result.count };
  }

  async listRoomParticipantUserIds(roomId: string): Promise<string[]> {
    const rows = await this.prisma.client.chatRoomParticipant.findMany({
      where: { roomId },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  private mapMessageRow(
    row: {
      id: string;
      roomId: string;
      senderId: string;
      content: string | null;
      status: 'SENT' | 'DELIVERED' | 'READ';
      createdAt: Date;
      editedAt?: Date | null;
      deletedAt: Date | null;
      parentMessageId?: string | null;
      parentMessage?: {
        id: string;
        senderId: string;
        content: string | null;
        createdAt: Date;
        deletedAt: Date | null;
      } | null;
      reactions?: { emoji: string; userId: string }[];
      attachments: {
        id: string;
        messageId: string;
        fileUrl: string;
        fileType: string;
        fileName: string;
        fileSize: number;
      }[];
    },
    viewerId?: string,
  ): ChatRoomMessage {
    const tally = new Map<string, { count: number; userIds: string[]; reactedByMe: boolean }>();
    for (const r of row.reactions ?? []) {
      const existing = tally.get(r.emoji) ?? {
        count: 0,
        userIds: [] as string[],
        reactedByMe: false,
      };
      existing.count += 1;
      existing.userIds.push(r.userId);
      if (viewerId && r.userId === viewerId) existing.reactedByMe = true;
      tally.set(r.emoji, existing);
    }
    const reactions: ChatReactionTally[] = Array.from(tally.entries()).map(([emoji, t]) => ({
      emoji,
      count: t.count,
      userIds: t.userIds,
      reactedByMe: t.reactedByMe,
    }));
    return {
      id: row.id,
      roomId: row.roomId,
      senderId: row.senderId,
      content: row.content,
      status: row.status,
      createdAt: row.createdAt,
      editedAt: row.editedAt ?? null,
      deletedAt: row.deletedAt,
      parentMessageId: row.parentMessageId ?? null,
      parentMessage: row.parentMessage
        ? {
            id: row.parentMessage.id,
            senderId: row.parentMessage.senderId,
            content: row.parentMessage.content,
            createdAt: row.parentMessage.createdAt,
            deletedAt: row.parentMessage.deletedAt,
          }
        : null,
      reactions,
      attachments: row.attachments.map((a) => ({
        id: a.id,
        messageId: a.messageId,
        fileUrl: a.fileUrl,
        fileType: a.fileType,
        fileName: a.fileName,
        fileSize: a.fileSize,
      })),
    };
  }
}

function generateInviteCode(): string {
  return randomBytes(9).toString('base64url');
}
