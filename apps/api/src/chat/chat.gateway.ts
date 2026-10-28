import { Logger, type OnModuleDestroy, Optional } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import {
  type CallAcceptInput,
  callAcceptSchema,
  type CallAnswerInput,
  callAnswerSchema,
  type CallEndInput,
  callEndSchema,
  type CallIceCandidateInput,
  callIceCandidateSchema,
  type CallInitiateInput,
  callInitiateSchema,
  type CallOfferInput,
  callOfferSchema,
  type CallRejectInput,
  callRejectSchema,
  type JoinRoomInput,
  joinRoomSchema,
  type MarkRoomReadInput,
  markRoomReadSchema,
  OS_NOTIFICATION_SOCKET_FEATURE,
  type SendChatMessageInput,
  sendChatMessageSchema,
  type TypingEventInput,
  typingEventSchema,
} from '@botss/shared-types';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';

import type { Subscription } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { RealtimeEventsService } from '../notifications/realtime-events.service';
import {
  type BusTopic,
  CrossProcessBus,
  isRecord,
  isStringArray,
} from '../redis/cross-process-bus.service';
import { ChatService } from './chat.service';

interface AuthedSocket extends Socket {
  data: { userId: string; sessionId: string; organizationId: string | null };
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}
/** Presence is only ever shared inside one organization. */
function orgRoom(organizationId: string | null): string {
  return `org:${organizationId ?? 'none'}`;
}
function chatRoom(roomId: string): string {
  return `room:${roomId}`;
}

interface SocketEmit {
  rooms: string[];
  event: string;
  payload: unknown;
}

/**
 * Socket broadcasts made in a process without a Socket.IO server (the
 * ROLE=worker process, e.g. the timesheet-warning cron's DMs) travel to the
 * api process over this topic and are emitted there.
 */
const SOCKET_EMIT_TOPIC: BusTopic<SocketEmit> = {
  name: 'socket-emit',
  decode(raw) {
    if (
      !isRecord(raw) ||
      !isStringArray(raw.rooms) ||
      raw.rooms.length === 0 ||
      typeof raw.event !== 'string'
    ) {
      return null;
    }
    return { rooms: raw.rooms, event: raw.event, payload: raw.payload };
  },
};

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WsException({
      title: 'Invalid payload',
      status: 400,
      detail: parsed.error.issues.map((i) => i.message).join('; '),
    });
  }
  return parsed.data;
}

// Allowlist mirrors the REST CORS handling in main.ts. The Socket.IO adapter
// is mounted separately from the Express middleware chain, so without this
// the REST origin allowlist would not protect the WebSocket - any third-party
// site could open an authenticated socket against /chat using the victim's
// cookie. Computed at module load to match the REST behaviour (env read once).
const chatAllowedOrigins = new Set(
  (process.env.WEB_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
if (process.env.NODE_ENV !== 'production') {
  chatAllowedOrigins.add('http://localhost:3000');
  chatAllowedOrigins.add('http://127.0.0.1:3000');
}
type CorsOriginCb = (err: Error | null, allow?: boolean) => void;
function chatCorsOrigin(origin: string | undefined, cb: CorsOriginCb): void {
  // Socket.IO calls back with allow=true to set Access-Control-Allow-Origin to
  // the request origin. Same-origin / non-browser clients send no Origin
  // header - those are allowed (cookie + auth-guard still gate them).
  if (!origin) return cb(null, true);
  cb(null, chatAllowedOrigins.has(origin));
}

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: chatCorsOrigin, credentials: true },
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer() server!: Server;

  private readonly onlineUsers = new Map<string, Set<string>>();
  private readonly lastSeen = new Map<string, Date>();
  /** userId -> organizationId for every online user, so presence can be
   *  filtered to the viewer's own tenant. */
  private readonly userOrg = new Map<string, string | null>();

  private notificationSub: Subscription | null = null;
  private pushSub: Subscription | null = null;
  private revokedSub: Subscription | null = null;
  private sessionIdsRevokedSub: Subscription | null = null;
  private socketEmitUnsub: (() => void) | null = null;

  constructor(
    private readonly auth: AuthService,
    private readonly chat: ChatService,
    private readonly realtime: RealtimeEventsService,
    @Optional() private readonly bus?: CrossProcessBus,
  ) {}

  /**
   * Emit to socket rooms from whichever process the caller runs in. The api
   * (or ROLE=all) process owns the Socket.IO server and emits directly. The
   * worker process has no server (it never initializes gateways), so the
   * emit is handed to the api process over the CrossProcessBus.
   */
  private emitTo(rooms: string | string[], event: string, payload: unknown): void {
    if (this.server) {
      this.server.to(rooms).emit(event, payload);
      return;
    }
    this.bus?.publish(SOCKET_EMIT_TOPIC, {
      rooms: Array.isArray(rooms) ? rooms : [rooms],
      event,
      payload,
    });
  }

  private markOnline(userId: string, socketId: string): boolean {
    let sockets = this.onlineUsers.get(userId);
    if (!sockets) {
      sockets = new Set();
      this.onlineUsers.set(userId, sockets);
    }
    const wasEmpty = sockets.size === 0;
    sockets.add(socketId);
    return wasEmpty;
  }

  private markOffline(userId: string, socketId: string): boolean {
    const sockets = this.onlineUsers.get(userId);
    if (!sockets) return false;
    sockets.delete(socketId);
    if (sockets.size === 0) {
      this.onlineUsers.delete(userId);
      this.lastSeen.set(userId, new Date());
      return true;
    }
    return false;
  }

  /** Online users inside one organization. Never the whole platform. */
  getOnlineUserIds(organizationId: string | null): string[] {
    return Array.from(this.onlineUsers.keys()).filter(
      (uid) => (this.userOrg.get(uid) ?? null) === organizationId,
    );
  }

  afterInit(): void {
    this.logger.log('Chat gateway initialised on /chat namespace.');
    // Forward every new bell row to the recipient's sockets. The desktop app
    // banners from this event, so it gets task, comment, lead, mail and every
    // other notification live, even while minimized to the tray.
    this.notificationSub = this.realtime.notifications$.subscribe(({ userId, notification }) => {
      this.server.to(userRoom(userId)).emit('notification_created', notification);
    });
    // Every OS push (bell rows, chat messages, incoming calls) also goes to
    // the recipients' sockets with the exact push payload. The desktop app
    // raises its OS banner from this, so it pops up for the same events a
    // phone does. One emit for all recipients.
    this.pushSub = this.realtime.pushes$.subscribe(({ userIds, payload }) => {
      try {
        this.server.to(userIds.map(userRoom)).emit('os_notification', payload);
      } catch (err) {
        this.logger.warn(
          `os_notification emit failed users=${userIds.length}: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    });
    // A socket authenticates once, at connect. When a user's sessions are
    // revoked (deactivation, removal, admin password/role change) their open
    // sockets must go too, or they keep receiving every room they joined.
    this.revokedSub = this.realtime.sessionsRevoked$.subscribe(({ userIds }) => {
      for (const uid of userIds) this.disconnectUser(uid);
    });
    // Devices page: close only the sockets opened by the deleted sessions.
    this.sessionIdsRevokedSub = this.realtime.sessionIdsRevoked$.subscribe(
      ({ userId, sessionIds }) => {
        void this.disconnectSessions(userId, sessionIds);
      },
    );
    // Broadcasts made by the worker process (ROLE=api only; no-op otherwise).
    this.socketEmitUnsub =
      this.bus?.subscribe(SOCKET_EMIT_TOPIC, ({ rooms, event, payload }) => {
        this.server.to(rooms).emit(event, payload);
      }) ?? null;
  }

  onModuleDestroy(): void {
    this.socketEmitUnsub?.();
    this.socketEmitUnsub = null;
    this.notificationSub?.unsubscribe();
    this.notificationSub = null;
    this.pushSub?.unsubscribe();
    this.pushSub = null;
    this.revokedSub?.unsubscribe();
    this.revokedSub = null;
    this.sessionIdsRevokedSub?.unsubscribe();
    this.sessionIdsRevokedSub = null;
  }

  /**
   * Take a user's sockets out of a chat room's broadcast channel after they
   * left it or were removed. `join_room` checks membership, but a socket that
   * joined earlier otherwise keeps receiving the room's messages.
   */
  evictFromRoom(userId: string, roomId: string): void {
    this.server.in(userRoom(userId)).socketsLeave(chatRoom(roomId));
  }

  /** Close every socket of a user (sessions revoked). */
  disconnectUser(userId: string): void {
    this.server.in(userRoom(userId)).disconnectSockets(true);
  }

  /** Close the user's sockets whose session id is in `sessionIds`. */
  async disconnectSessions(userId: string, sessionIds: string[]): Promise<void> {
    const doomed = new Set(sessionIds);
    try {
      const sockets = await this.server.in(userRoom(userId)).fetchSockets();
      for (const s of sockets) {
        const sid = (s.data as { sessionId?: string } | undefined)?.sessionId;
        if (sid && doomed.has(sid)) s.disconnect(true);
      }
    } catch (err) {
      this.logger.warn(`Could not close revoked sockets for ${userId}: ${String(err)}`);
    }
  }

  async handleConnection(socket: Socket): Promise<void> {
    const headers = this.headersFromHandshake(socket);
    let session: Awaited<ReturnType<AuthService['getSessionFromHeaders']>>;
    let orgContext: Awaited<ReturnType<AuthService['getUserOrgContext']>>;
    try {
      session = await this.auth.getSessionFromHeaders(headers);
      if (!session) {
        socket.emit('auth_error', { title: 'Unauthorized', status: 401 });
        socket.disconnect(true);
        return;
      }
      orgContext = await this.auth.getUserOrgContext(session.user.id);
    } catch (err) {
      // Infrastructure hiccup (DB down, deploy restart). Not an auth answer:
      // the client retries instead of treating it as signed out.
      this.logger.warn(
        `Socket auth lookup failed socketId=${socket.id} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      socket.emit('server_unavailable', { status: 503 });
      socket.disconnect(true);
      return;
    }
    // Same gates as the REST AuthGuard: an offboarded user or a suspended
    // tenant must not hold a live socket just because the cookie survives.
    if (orgContext.userDisabled || orgContext.orgInactive) {
      socket.emit('auth_error', { title: 'Unauthorized', status: 401 });
      socket.disconnect(true);
      return;
    }
    // Client-portal accounts have no chat. They also have no org, and every
    // org-less socket would share one `orgRoom(null)` - presence would leak
    // between unrelated clients. Refuse before joining any room.
    if (orgContext.accountType === 'CLIENT') {
      socket.emit('auth_error', {
        title: 'Client portal account',
        status: 403,
        code: 'portal-only',
      });
      socket.disconnect(true);
      return;
    }
    const userId = session.user.id;
    const organizationId = orgContext.organizationId;
    (socket as AuthedSocket).data = {
      userId,
      sessionId: session.session.id,
      organizationId,
    };
    this.userOrg.set(userId, organizationId);
    await socket.join(userRoom(userId));
    await socket.join(orgRoom(organizationId));
    const cameOnline = this.markOnline(userId, socket.id);
    socket.emit('connected', {
      userId,
      onlineUserIds: this.getOnlineUserIds(organizationId),
      // Lets a client switch to the server-driven desktop banners only when
      // this API actually emits them (web can deploy before the API).
      features: [OS_NOTIFICATION_SOCKET_FEATURE],
    });
    if (cameOnline) {
      // Presence stays inside the tenant. It used to go to every socket on
      // the platform, which let any user enumerate every org's user ids.
      socket.to(orgRoom(organizationId)).emit('presence_update', {
        userId,
        online: true,
        lastSeenAt: null,
      });
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    const auth = (socket as AuthedSocket).data;
    if (!auth?.userId) return;
    const wentOffline = this.markOffline(auth.userId, socket.id);
    if (wentOffline) {
      this.userOrg.delete(auth.userId);
      this.server.to(orgRoom(auth.organizationId ?? null)).emit('presence_update', {
        userId: auth.userId,
        online: false,
        lastSeenAt: this.lastSeen.get(auth.userId) ?? new Date(),
      });
    }
    try {
      const closed = await this.chat.dropCallsForSocket(socket.id);
      for (const c of closed) {
        for (const uid of c.participants) {
          this.server.to(userRoom(uid)).emit('call_ended', {
            callId: c.callId,
            roomId: c.roomId,
            status: 'COMPLETED',
          });
        }
        if (c.callLog) {
          await this.broadcastNewMessage({
            roomId: c.roomId,
            senderUserId: c.callLog.senderId,
            message: c.callLog,
            clientNonce: null,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `dropCallsForSocket failed socketId=${socket.id} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
    this.logger.debug(`Socket disconnected userId=${auth.userId} socketId=${socket.id}`);
  }

  @SubscribeMessage('join_room')
  async onJoinRoom(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true; roomId: string }> {
    const input: JoinRoomInput = parseOrThrow(joinRoomSchema, raw);
    await this.chat.assertRoomMember(socket.data.userId, input.roomId);
    await socket.join(chatRoom(input.roomId));
    const { updated } = await this.chat.markDelivered(socket.data.userId, input.roomId);
    if (updated > 0) {
      this.server.to(chatRoom(input.roomId)).emit('msg_status_update', {
        roomId: input.roomId,
        status: 'DELIVERED',
        byUserId: socket.data.userId,
      });
    }
    return { ok: true, roomId: input.roomId };
  }

  @SubscribeMessage('leave_room')
  async onLeaveRoom(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: JoinRoomInput = parseOrThrow(joinRoomSchema, raw);
    await socket.leave(chatRoom(input.roomId));
    return { ok: true };
  }

  @SubscribeMessage('send_msg')
  async onSendMessage(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true; messageId: string; clientNonce: string | null }> {
    try {
      const input: SendChatMessageInput = parseOrThrow(sendChatMessageSchema, raw);
      const message = await this.chat.sendMessage(socket.data.userId, input);
      await this.broadcastNewMessage({
        roomId: input.roomId,
        senderUserId: socket.data.userId,
        message,
        clientNonce: input.clientNonce ?? null,
      });
      return {
        ok: true,
        messageId: message.id,
        clientNonce: input.clientNonce ?? null,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unable to send message';
      this.logger.warn(`send_msg failed userId=${socket.data.userId} message=${detail}`);
      throw new WsException({ title: 'Send failed', status: 500, detail });
    }
  }

  async broadcastReactionUpdate(args: {
    messageId: string;
    roomId: string;
    reactions: Awaited<ReturnType<ChatService['toggleReaction']>>['reactions'];
  }): Promise<void> {
    this.emitTo(chatRoom(args.roomId), 'reaction_update', {
      messageId: args.messageId,
      roomId: args.roomId,
      reactions: args.reactions,
    });
  }

  async broadcastNewMessage(args: {
    roomId: string;
    senderUserId: string;
    message: Awaited<ReturnType<ChatService['sendMessage']>>;
    clientNonce: string | null;
  }): Promise<void> {
    const { roomId, senderUserId, message, clientNonce } = args;
    const peers = await this.chat.listRoomParticipantUserIds(roomId);
    // The sender is always a target. Their own sidebar has to re-sort the
    // room to the top the moment they send, and their OTHER devices (phone,
    // desktop app) only learn about the send through this event - they are
    // not necessarily joined to the room's socket-room, so `msg_received`
    // never reaches them. Consumers already ignore self-sent messages for
    // sounds / banners / bell rows, so including the sender is safe.
    const allTargets = new Set(peers);
    allTargets.add(senderUserId);
    this.emitTo(chatRoom(roomId), 'msg_received', { ...message, clientNonce });
    // One broadcast to every target's user room instead of one emit per user.
    this.emitTo(Array.from(allTargets, userRoom), 'room_bumped', {
      roomId,
      lastMessage: message,
    });
  }

  /**
   * Push an edited message to everyone in the room so open clients swap the
   * body in place. Mirrors `broadcastNewMessage` but with an `msg_updated`
   * event the client maps onto the existing message id.
   */
  async broadcastMessageUpdated(args: {
    roomId: string;
    message: Awaited<ReturnType<ChatService['editMessage']>>;
  }): Promise<void> {
    this.emitTo(chatRoom(args.roomId), 'msg_updated', args.message);
  }

  /**
   * Typing events are the chattiest socket traffic. A socket that joined the
   * room already passed `assertRoomMember` in `join_room`, so its socket.io
   * room membership answers without a database read. A socket that has not
   * joined is checked against the database exactly as before.
   */
  private async assertTypingAllowed(socket: AuthedSocket, roomId: string): Promise<void> {
    if (socket.rooms.has(chatRoom(roomId))) return;
    await this.chat.assertRoomMember(socket.data.userId, roomId);
  }

  @SubscribeMessage('typing_start')
  async onTypingStart(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: TypingEventInput = parseOrThrow(typingEventSchema, raw);
    await this.assertTypingAllowed(socket, input.roomId);
    socket.to(chatRoom(input.roomId)).emit('typing_start', {
      roomId: input.roomId,
      userId: socket.data.userId,
    });
    return { ok: true };
  }

  @SubscribeMessage('typing_stop')
  async onTypingStop(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: TypingEventInput = parseOrThrow(typingEventSchema, raw);
    await this.assertTypingAllowed(socket, input.roomId);
    socket.to(chatRoom(input.roomId)).emit('typing_stop', {
      roomId: input.roomId,
      userId: socket.data.userId,
    });
    return { ok: true };
  }

  @SubscribeMessage('mark_read')
  async onMarkRead(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true; updated: number }> {
    const input: MarkRoomReadInput = parseOrThrow(markRoomReadSchema, raw);
    const result = await this.chat.markRead(socket.data.userId, input.roomId, input.upToMessageId);
    if (result.updated > 0) {
      this.server.to(chatRoom(input.roomId)).emit('msg_status_update', {
        roomId: input.roomId,
        status: 'READ',
        byUserId: socket.data.userId,
        messageIds: result.messageIds,
      });
    }
    return { ok: true, updated: result.updated };
  }

  @SubscribeMessage('call_initiate')
  async onCallInitiate(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true; callId: string }> {
    try {
      const input: CallInitiateInput = parseOrThrow(callInitiateSchema, raw);
      // Membership FIRST. Force-ending the room's current call (and writing a
      // call-log row into the room) used to run before any check, so anyone
      // could kill a call in a room they were never in.
      await this.chat.assertRoomMember(socket.data.userId, input.roomId);
      await this.chat.forceEndCallByRoom(input.roomId);
      const { call, receiverUserIds } = await this.chat.initiateCall(
        socket.data.userId,
        socket.id,
        input.roomId,
      );
      await this.broadcastCallIncoming({
        callId: call.id,
        roomId: input.roomId,
        callerId: socket.data.userId,
        receiverUserIds,
      });
      socket.emit('call_ringing', { callId: call.id, roomId: input.roomId });
      return { ok: true, callId: call.id };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Unable to start call';
      this.logger.warn(`call_initiate failed userId=${socket.data.userId} message=${detail}`);
      throw new WsException({ title: 'Start call failed', status: 500, detail });
    }
  }

  async broadcastCallIncoming(args: {
    callId: string;
    roomId: string;
    callerId: string;
    receiverUserIds: string[];
  }): Promise<void> {
    for (const uid of args.receiverUserIds) {
      this.server.to(userRoom(uid)).emit('call_incoming', {
        callId: args.callId,
        roomId: args.roomId,
        callerId: args.callerId,
      });
    }
  }

  @SubscribeMessage('call_accept')
  async onCallAccept(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallAcceptInput = parseOrThrow(callAcceptSchema, raw);
    const { call, callerId, callerSocketId, roomId } = await this.chat.acceptCall(
      input.callId,
      socket.data.userId,
    );
    const payload = {
      callId: call.id,
      roomId,
      byUserId: socket.data.userId,
      bySocketId: socket.id,
    };
    this.server.to(userRoom(callerId)).emit('call_accepted', payload);
    if (callerSocketId && !callerSocketId.startsWith('rest:')) {
      this.server.to(callerSocketId).emit('call_accepted', payload);
    }
    socket.emit('call_connected', { callId: call.id, roomId });
    return { ok: true };
  }

  @SubscribeMessage('call_reject')
  async onCallReject(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallRejectInput = parseOrThrow(callRejectSchema, raw);
    const result = await this.chat.rejectCall(input.callId, socket.data.userId);
    const { callerId, roomId, callLog } = result;
    if (callerId && roomId) {
      this.server.to(userRoom(callerId)).emit('call_rejected', {
        callId: input.callId,
        roomId,
        byUserId: socket.data.userId,
      });
    }
    if (roomId && callLog) {
      await this.broadcastNewMessage({
        roomId,
        senderUserId: callLog.senderId,
        message: callLog,
        clientNonce: null,
      });
    }
    return { ok: true };
  }

  @SubscribeMessage('call_end')
  async onCallEnd(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallEndInput = parseOrThrow(callEndSchema, raw);
    const result = await this.chat.endCall(input.callId, socket.data.userId);
    const { call, participants, callLog, roomId } = result;
    if (!call) return { ok: true };
    for (const uid of participants) {
      this.server.to(userRoom(uid)).emit('call_ended', {
        callId: call.id,
        roomId: call.receiverRoomId,
        status: call.status,
      });
    }
    if (roomId && callLog) {
      await this.broadcastNewMessage({
        roomId,
        senderUserId: callLog.senderId,
        message: callLog,
        clientNonce: null,
      });
    }
    return { ok: true };
  }

  /**
   * Push a `messages_purged` event so all clients live-update their chat
   * window. Used by both single-message and whole-room deletes.
   */
  async broadcastMessagesPurged(args: {
    roomId: string;
    messageIds: string[] | 'all';
  }): Promise<void> {
    this.emitTo(chatRoom(args.roomId), 'messages_purged', args);
    const peers = await this.chat.listRoomParticipantUserIds(args.roomId);
    for (const uid of peers) {
      this.emitTo(userRoom(uid), 'messages_purged', args);
    }
  }

  /**
   * Broadcast a READ status update for messages a user just marked as
   * read via the REST endpoint. Mirrors what the socket `mark_read`
   * handler does so peer clients (the original senders) see their blue
   * ticks light up live. Fans out to both the chat-room socket (open
   * windows) and each participant's user-room (sidebar listeners).
   */
  async broadcastReadStatus(args: {
    roomId: string;
    byUserId: string;
    messageIds: string[];
  }): Promise<void> {
    const payload = {
      roomId: args.roomId,
      status: 'READ' as const,
      byUserId: args.byUserId,
      messageIds: args.messageIds,
    };
    this.emitTo(chatRoom(args.roomId), 'msg_status_update', payload);
    const peers = await this.chat.listRoomParticipantUserIds(args.roomId);
    for (const uid of peers) {
      this.emitTo(userRoom(uid), 'msg_status_update', payload);
    }
  }

  @SubscribeMessage('webrtc_offer')
  async onWebrtcOffer(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallOfferInput = parseOrThrow(callOfferSchema, raw);
    // Only a member of the call's room may signal, and only to someone in it.
    await this.authorizeSignal(input.callId, socket.data.userId, input.toUserId);
    this.server.to(userRoom(input.toUserId)).emit('webrtc_offer', {
      callId: input.callId,
      fromUserId: socket.data.userId,
      fromSocketId: socket.id,
      description: input.description,
    });
    return { ok: true };
  }

  @SubscribeMessage('webrtc_answer')
  async onWebrtcAnswer(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallAnswerInput = parseOrThrow(callAnswerSchema, raw);
    await this.authorizeSignal(input.callId, socket.data.userId, input.toUserId);
    this.server.to(userRoom(input.toUserId)).emit('webrtc_answer', {
      callId: input.callId,
      fromUserId: socket.data.userId,
      fromSocketId: socket.id,
      description: input.description,
    });
    return { ok: true };
  }

  @SubscribeMessage('webrtc_ice_candidate')
  async onWebrtcIceCandidate(
    @ConnectedSocket() socket: AuthedSocket,
    @MessageBody() raw: unknown,
  ): Promise<{ ok: true }> {
    const input: CallIceCandidateInput = parseOrThrow(callIceCandidateSchema, raw);
    // ICE fires frequently. assertCallSignal hits the DB at most once per
    // sender per call and authorizes from memory after that.
    await this.authorizeSignal(input.callId, socket.data.userId, input.toUserId);
    this.server.to(userRoom(input.toUserId)).emit('webrtc_ice_candidate', {
      callId: input.callId,
      fromUserId: socket.data.userId,
      fromSocketId: socket.id,
      candidate: input.candidate,
    });
    return { ok: true };
  }

  private async authorizeSignal(
    callId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<void> {
    try {
      await this.chat.assertCallSignal(callId, fromUserId, toUserId);
    } catch (err) {
      const status = (err as { getStatus?: () => number })?.getStatus?.() ?? 403;
      throw new WsException({
        title: status === 404 ? 'Unknown call' : 'Signaling not allowed',
        status,
      });
    }
  }

  private headersFromHandshake(socket: Socket): Headers {
    const headers = new Headers();
    const raw = socket.handshake.headers as Record<string, string | string[] | undefined>;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    return headers;
  }
}
