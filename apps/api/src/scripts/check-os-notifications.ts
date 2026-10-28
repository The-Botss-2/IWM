/**
 * Desktop OS notifications (A6), no database, Redis or push credentials:
 *
 * 1. `sendDesktopNotificationToUsers` publishes the push to the live stream
 *    (-> the gateway's `os_notification`) even with no VAPID keys and no
 *    devices, once per call, de-duplicated users, with exactly the payload
 *    the phones get from Expo.
 * 2. Bell rows: a pushable row reaches the stream with its notification id,
 *    url and entity tag; a `skipPush` row (chat bell rows) does not, since
 *    the chat push already covered it.
 * 3. Chat: the message push goes through the same path, never to the
 *    sender, with `data.messageId`; a DM's bell rows add no second event.
 * 4. Calls: the incoming-call push goes through it with `type: 'call'`.
 * 5. Gateway: one `os_notification` emit to every recipient's user room,
 *    `connected` advertises the feature, and the subscription ends on
 *    module destroy.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { Logger } from '@nestjs/common';
import { type DesktopPushPayload, OS_NOTIFICATION_SOCKET_FEATURE } from '@botss/shared-types';
import type { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';

import { ChatGateway } from '../chat/chat.gateway';
import { ChatService } from '../chat/chat.service';
import { NotificationsPushService } from '../notifications/notifications-push.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  type RealtimeNotificationEvent,
  type RealtimePushFanout,
  RealtimeEventsService,
} from '../notifications/realtime-events.service';
import type { PrismaService } from '../prisma/prisma.service';

// The live leg must never depend on Web Push being configured.
delete process.env.VAPID_SUBJECT;
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
// The services' "Web Push disabled" warnings are expected here.
Logger.overrideLogger(['error']);

const SENDER = 'cmsender000000000000000000';
const USER_B = 'cmuserb00000000000000000b';
const USER_C = 'cmuserc00000000000000000c';
const ROOM = 'cmroom00000000000000000000';
const MESSAGE = 'cmmessage00000000000000000';
const EXPO_TOKEN = 'ExponentPushToken[abcdefghijklmnopqrstuv]';

interface FakeRoom {
  name: string | null;
  type: 'DM' | 'GROUP' | 'TEXT_CHANNEL';
  participants: Array<{ userId: string }>;
}

/** The slice of Prisma these paths touch. */
function fakePrisma(
  opts: { room?: FakeRoom; devices?: Array<{ id: string; token: string }> } = {},
) {
  let seq = 0;
  const row = (data: Record<string, unknown>) => ({
    id: `cmnotif${String((seq += 1)).padStart(18, '0')}`,
    createdAt: new Date('2026-10-26T10:00:00.000Z'),
    readAt: null,
    actorId: null,
    taskId: null,
    commentId: null,
    entityType: null,
    entityId: null,
    url: null,
    ...data,
  });
  const client = {
    userPushDevice: { findMany: async () => opts.devices ?? [], delete: async () => ({}) },
    userNotificationSubscription: { findMany: async () => [], delete: async () => ({}) },
    notification: {
      create: async ({ data }: { data: Record<string, unknown> }) => row(data),
      createManyAndReturn: async ({ data }: { data: Array<Record<string, unknown>> }) =>
        data.map(row),
    },
    chatRoom: { findUnique: async () => opts.room ?? null },
    user: { findUnique: async () => ({ name: 'Sara', email: 'sara@example.com' }) },
  };
  return { client } as unknown as PrismaService;
}

function wire(opts: Parameters<typeof fakePrisma>[0] = {}) {
  const prisma = fakePrisma(opts);
  const realtime = new RealtimeEventsService();
  const push = new NotificationsPushService(prisma, realtime);
  const notifications = new NotificationsService(prisma, push, realtime);
  const chat = new ChatService(prisma, notifications, push);
  const pushes: RealtimePushFanout[] = [];
  const bell: RealtimeNotificationEvent[] = [];
  realtime.pushes$.subscribe((e) => pushes.push(e));
  realtime.notifications$.subscribe((e) => bell.push(e));
  return { realtime, push, notifications, chat, pushes, bell };
}

/** Let fire-and-forget legs settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function withoutPushId(e: RealtimePushFanout): DesktopPushPayload {
  const { pushId, ...rest } = e.payload;
  assert.ok(typeof pushId === 'string' && pushId.length > 0, 'every live push carries a pushId');
  return rest;
}

async function main(): Promise<void> {
  // --- 1. the push service publishes live, whatever is configured ----------
  {
    const { push, pushes } = wire({ devices: [{ id: 'dev1', token: EXPO_TOKEN }] });
    const sentToExpo: ExpoPushMessage[] = [];
    (
      push as unknown as {
        expo: { sendPushNotificationsAsync: (c: ExpoPushMessage[]) => Promise<ExpoPushTicket[]> };
      }
    ).expo.sendPushNotificationsAsync = async (chunk) => {
      sentToExpo.push(...chunk);
      return chunk.map(() => ({ status: 'ok' as const, id: 'ticket' }));
    };
    const payload: DesktopPushPayload = {
      title: 'Task assigned',
      body: 'Fix the login page',
      type: 'generic',
      url: '/projects/p1?task=t1',
      tag: 'task:t1',
      data: { notificationId: 'n1', entityType: 'task', entityId: 't1' },
    };
    const result = await push.sendDesktopNotificationToUsers([USER_B, USER_B, USER_C], payload);
    await settle();
    assert.deepEqual(result, { sent: 0, dropped: 0 }, 'no Web Push without VAPID');
    assert.equal(pushes.length, 1, 'one live publish per send');
    assert.deepEqual(pushes[0]!.userIds, [USER_B, USER_C], 'recipients de-duplicated');
    assert.deepEqual(
      withoutPushId(pushes[0]!),
      payload,
      'live payload is the push payload, unchanged',
    );

    assert.equal(sentToExpo.length, 1, 'the phone got its native push too');
    const expo = sentToExpo[0]!;
    assert.equal(expo.title, payload.title, 'same title as the phone');
    assert.equal(expo.body, payload.body, 'same body as the phone');
    assert.deepEqual(
      expo.data,
      { url: payload.url, ...payload.data },
      'same url + data as the phone',
    );

    await push.sendDesktopNotificationToUsers([], payload);
    assert.equal(pushes.length, 1, 'nobody to notify, nothing published');

    const second = await push.sendDesktopNotification(USER_B, payload).then(() => pushes[1]);
    assert.ok(
      second && second.payload.pushId !== pushes[0]!.payload.pushId,
      'pushId is unique per send',
    );
  }

  // --- 2. bell rows ---------------------------------------------------------
  {
    const { notifications, pushes, bell } = wire();
    const row = await notifications.emit({
      userId: USER_B,
      actorId: SENDER,
      type: 'TASK_ASSIGNED',
      title: 'Sara assigned you a task',
      body: 'Fix the login page',
      entityType: 'task',
      entityId: 't1',
      url: '/projects/p1?task=t1',
    });
    assert.equal(bell.length, 1, 'bell refresh published');
    assert.equal(pushes.length, 1, 'pushable bell row reaches the live stream');
    assert.deepEqual(pushes[0]!.userIds, [USER_B]);
    assert.deepEqual(withoutPushId(pushes[0]!), {
      title: 'Sara assigned you a task',
      body: 'Fix the login page',
      type: 'generic',
      url: '/projects/p1?task=t1',
      tag: 'task:t1',
      data: { notificationId: row.id, entityType: 'task', entityId: 't1' },
    });

    await notifications.emitMany([USER_B, USER_C], {
      type: 'MENTION',
      title: 'Sara mentioned you',
      body: 'hi',
      entityType: 'chat',
      entityId: ROOM,
      url: `/chat/${ROOM}`,
      pushType: 'message',
      skipPush: true,
    });
    assert.equal(bell.length, 3, 'skipPush rows still refresh the bell');
    assert.equal(pushes.length, 1, 'skipPush rows add no os_notification');

    await notifications.emitMany([USER_B, USER_C], {
      type: 'PROJECT_ADDED',
      title: 'Added to a project',
      body: 'Website',
      entityType: 'project',
      entityId: 'p1',
      url: '/projects/p1',
    });
    assert.equal(pushes.length, 3, 'emitMany pushes each recipient');
    assert.deepEqual(
      pushes.slice(1).map((e) => e.userIds),
      [[USER_B], [USER_C]],
    );
  }

  // --- 3. chat messages -----------------------------------------------------
  {
    const room: FakeRoom = {
      name: 'ops',
      type: 'TEXT_CHANNEL',
      participants: [{ userId: SENDER }, { userId: USER_B }, { userId: USER_C }],
    };
    const { chat, pushes, bell } = wire({ room });
    await chat.runMessageFanout({
      kind: 'message',
      roomId: ROOM,
      senderUserId: SENDER,
      content: 'deploy is done',
      mentionedUserIds: [],
      messageId: MESSAGE,
    });
    await settle();
    assert.equal(pushes.length, 1, 'one live push for the message');
    assert.deepEqual(pushes[0]!.userIds, [USER_B, USER_C], 'never to the sender');
    assert.deepEqual(withoutPushId(pushes[0]!), {
      title: 'ops',
      body: 'Sara: deploy is done',
      type: 'message',
      url: `/chat/${ROOM}`,
      tag: `chat:${ROOM}`,
      data: { roomId: ROOM, senderUserId: SENDER, messageId: MESSAGE },
    });
    assert.equal(bell.length, 0, 'plain channel chatter has no bell row');

    const dm = wire({
      room: { name: null, type: 'DM', participants: [{ userId: SENDER }, { userId: USER_B }] },
    });
    await dm.chat.runMessageFanout({
      kind: 'message',
      roomId: ROOM,
      senderUserId: SENDER,
      content: 'x'.repeat(600),
      mentionedUserIds: [],
    });
    await settle();
    assert.equal(dm.bell.length, 1, 'a DM writes a bell row');
    assert.equal(dm.pushes.length, 1, "the DM's bell row adds no second banner");
    assert.equal(
      dm.pushes[0]!.payload.data?.['messageId'],
      undefined,
      'older jobs without an id still push',
    );
    assert.ok(dm.pushes[0]!.payload.body.length <= 400, 'body within the payload schema');
  }

  // --- 4. incoming calls ----------------------------------------------------
  {
    const { chat, pushes } = wire();
    await (
      chat as unknown as {
        fanoutCallPush: (r: string, c: string, id: string, to: string[]) => Promise<void>;
      }
    ).fanoutCallPush(ROOM, SENDER, 'call1', [USER_B, USER_C]);
    assert.equal(pushes.length, 2, 'one call push per receiver');
    for (const e of pushes) {
      assert.deepEqual(withoutPushId(e), {
        title: 'Incoming call from Sara',
        body: 'Tap to answer.',
        type: 'call',
        url: `/chat/${ROOM}?call=call1`,
        tag: `call:${ROOM}`,
        data: { roomId: ROOM, callId: 'call1', callerId: SENDER },
      });
    }
    assert.deepEqual(
      pushes.map((e) => e.userIds),
      [[USER_B], [USER_C]],
    );
  }

  // --- 5. gateway -----------------------------------------------------------
  {
    const realtime = new RealtimeEventsService();
    const gateway = new ChatGateway({} as never, {} as never, realtime);
    const emits: Array<{ rooms: unknown; event: string; payload: unknown }> = [];
    gateway.server = {
      to: (rooms: unknown) => ({
        emit: (event: string, payload: unknown) => {
          emits.push({ rooms, event, payload });
          return true;
        },
      }),
    } as unknown as ChatGateway['server'];
    gateway.afterInit();
    const payload = {
      pushId: 'p1',
      title: 'ops',
      body: 'hi',
      type: 'message' as const,
      url: `/chat/${ROOM}`,
    };
    realtime.publishPush({ userIds: [USER_B, USER_C], payload });
    assert.equal(emits.length, 1, 'one emit for all recipients');
    assert.deepEqual(emits[0], {
      rooms: [`user:${USER_B}`, `user:${USER_C}`],
      event: 'os_notification',
      payload,
    });
    gateway.onModuleDestroy();
    realtime.publishPush({ userIds: [USER_B], payload });
    assert.equal(emits.length, 1, 'unsubscribed on module destroy');

    // `connected` advertises the feature.
    const auth = {
      getSessionFromHeaders: async () => ({ user: { id: USER_B }, session: { id: 's1' } }),
      getUserOrgContext: async () => ({
        organizationId: 'cmorg0000000000000000000a',
        userDisabled: false,
        orgInactive: false,
        accountType: 'STAFF',
      }),
    };
    const gw2 = new ChatGateway(auth as never, {} as never, new RealtimeEventsService());
    gw2.server = { to: () => ({ emit: () => true }) } as unknown as ChatGateway['server'];
    const socketEmits: Array<{ event: string; payload: unknown }> = [];
    const socket = {
      id: 'sock1',
      handshake: { headers: {} },
      data: {},
      join: async () => undefined,
      emit: (event: string, payload: unknown) => {
        socketEmits.push({ event, payload });
        return true;
      },
      to: () => ({ emit: () => true }),
      disconnect: () => undefined,
    };
    await gw2.handleConnection(socket as never);
    const connected = socketEmits.find((e) => e.event === 'connected');
    assert.ok(connected, 'connected emitted');
    assert.deepEqual(
      (connected.payload as { features?: unknown }).features,
      [OS_NOTIFICATION_SOCKET_FEATURE],
      'connected advertises os_notification',
    );
  }

  console.log('OK check-os-notifications');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
