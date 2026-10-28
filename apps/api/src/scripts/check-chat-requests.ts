/**
 * Cross-organization chat request self-checks (no database, no Redis).
 *
 * ChatRequestsService and ChatService run against an in-memory fake Prisma
 * that EVALUATES each `where` it is given (equality, not / gte / in, AND / OR,
 * and the relations the request rules use), so a dropped filter returns a
 * row it should not and the check fails. Covered:
 *  - send never reads a user before answering, and a known and an unknown
 *    address get the same response through the same queries (one read, one
 *    write); delivery happens afterwards;
 *  - the 11th send in an hour is a 429 and writes nothing;
 *  - accept refuses blocked, same-org, client-account and suspended-org
 *    requesters, opens a DM with the request as its first message, and a
 *    racing second accept is a 409;
 *  - createRoom still refuses a cross-org DM;
 *  - share into a cross-org DM is a 404, forwarding into it from another room
 *    a 403, and a block silences the DM.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { CHAT_REQUEST_SENT_NOTICE } from '@botss/shared-types';

import { ChatRequestsService } from '../chat/chat-requests.service';
import { ChatService } from '../chat/chat.service';
import { LivekitService } from '../livekit/livekit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const ORG_A = 'cmorga000000000000000000a';
const ORG_B = 'cmorgb000000000000000000b';
const ORG_SUSPENDED = 'cmorgs000000000000000000s';

const SENDER = 'cmsender00000000000000000';
const ME = 'cmme000000000000000000000';
const REQ_OK = 'cmreqok000000000000000000';
const REQ_BLOCKED = 'cmreqblocked0000000000000';
const REQ_SAME = 'cmreqsame0000000000000000';
const REQ_CLIENT = 'cmreqclient00000000000000';
const REQ_SUSP = 'cmreqsusp0000000000000000';

const MY_EMAIL = 'me@company-b.test';
const ROOM_X = 'cmroomx000000000000000000';
const ROOM_SAME = 'cmroomsame000000000000000';
const MSG_SAME = 'cmmsgsame0000000000000000';

const now = new Date();
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number): Date => new Date(now.getTime() - d * DAY);

function user(id: string, organizationId: string | null, extra: Row = {}): Row {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    image: null,
    accountType: 'STAFF',
    deletedAt: null,
    organizationId,
    createdAt: daysAgo(365),
    ...extra,
  };
}

interface Store {
  orgs: Row[];
  users: Row[];
  requests: Row[];
  blocks: Row[];
  rooms: Array<{
    id: string;
    type: string;
    participants: Array<{ id: string; userId: string; role: string }>;
    workspaceId: null;
    createdById: string | null;
  }>;
  messages: Row[];
}

function seedStore(): Store {
  return {
    orgs: [
      { id: ORG_A, name: 'Company A', isActive: true, deletedAt: null },
      { id: ORG_B, name: 'Company B', isActive: true, deletedAt: null },
      { id: ORG_SUSPENDED, name: 'Suspended', isActive: false, deletedAt: null },
    ],
    users: [
      user(SENDER, ORG_A),
      user(ME, ORG_B, { email: MY_EMAIL }),
      user(REQ_OK, ORG_A),
      user(REQ_BLOCKED, ORG_A),
      user(REQ_SAME, ORG_B),
      user(REQ_CLIENT, ORG_A, { accountType: 'CLIENT' }),
      user(REQ_SUSP, ORG_SUSPENDED),
    ],
    requests: [REQ_OK, REQ_BLOCKED, REQ_SAME, REQ_CLIENT, REQ_SUSP].map((rid) => ({
      id: `cmrq${rid.slice(4)}`,
      requesterId: rid,
      recipientEmail: MY_EMAIL,
      recipientId: null,
      message: `hello from ${rid}`,
      status: 'PENDING',
      roomId: null,
      attemptCount: 1,
      sentAt: daysAgo(1),
      respondedAt: null,
    })),
    blocks: [{ id: 'cmblock0', blockerId: ME, blockedUserId: REQ_BLOCKED, createdAt: now }],
    rooms: [],
    messages: [],
  };
}
const requestIdOf = (requesterId: string): string => `cmrq${requesterId.slice(4)}`;

// --- where evaluator -----------------------------------------------------------

type Relations = Record<string, (row: Row, cond: Where) => boolean>;

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond !== 'object') return value === cond;
  const c = cond as Where;
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case 'equals':
        if (c['mode'] === 'insensitive') {
          if (String(value).toLowerCase() !== String(arg).toLowerCase()) return false;
        } else if (value !== arg) return false;
        break;
      case 'mode':
        break;
      case 'not':
        // SQL semantics: `col <> x` is never true for NULL.
        if (arg === null) {
          if (value === null || value === undefined) return false;
        } else if (value === null || value === undefined || value === arg) return false;
        break;
      case 'in':
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case 'gte':
        if (!(value instanceof Date) || value < (arg as Date)) return false;
        break;
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

function matches(row: Row, where: Where | undefined, relations: Relations): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'NOT') {
      if (matches(row, cond as Where, relations)) return false;
    } else if (key === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w, relations))) return false;
    } else if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w, relations))) return false;
    } else if (relations[key]) {
      if (!relations[key]!(row, cond as Where)) return false;
    } else if (!fieldMatches(row[key], cond)) {
      return false;
    }
  }
  return true;
}

// --- fake Prisma -----------------------------------------------------------------

function fakePrisma(store: Store) {
  const log: string[] = [];
  const writes: string[] = [];
  let nextId = 0;

  const userRelations: Relations = {
    organization: (u, cond) => {
      const org = store.orgs.find((o) => o.id === u['organizationId']);
      return !!org && matches(org, cond, {});
    },
    chatRequestBlocksReceived: (u, cond) => {
      const none = (cond as { none?: Where }).none;
      if (!none) throw new Error('fake prisma: only `none` on chatRequestBlocksReceived');
      return !store.blocks.some((b) => b['blockedUserId'] === u['id'] && matches(b, none, {}));
    },
  };
  const requestRelations: Relations = {
    requester: (r, cond) => {
      const u = store.users.find((x) => x['id'] === r['requesterId']);
      return !!u && matches(u, cond, userRelations);
    },
  };

  // Rooms: `participants` (some) over participant rows whose `user` is
  // evaluated like a user; `workspace` never matches (fake rooms have none).
  const participantRelations: Relations = {
    user: (p, cond) => {
      const u = store.users.find((x) => x['id'] === p['userId']);
      return !!u && matches(u, cond, userRelations);
    },
  };
  const roomRelations: Relations = {
    participants: (r, cond) => {
      const some = (cond as { some?: Where }).some;
      if (!some) throw new Error('fake prisma: only `some` on room participants');
      return (r['participants'] as Row[]).some((p) => matches(p, some, participantRelations));
    },
    workspace: () => false,
  };

  const roomRow = (room: Store['rooms'][number]) => ({
    id: room.id,
    messages: [],
    type: room.type,
    name: null,
    description: null,
    workspaceId: null,
    workspace: null,
    projectId: null,
    createdById: room.createdById,
    isPrivate: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    participants: room.participants.map((p) => {
      const u = store.users.find((x) => x['id'] === p.userId)!;
      return {
        id: p.id,
        userId: p.userId,
        role: p.role,
        joinedAt: now,
        user: {
          id: u['id'],
          name: u['name'],
          email: u['email'],
          image: null,
          organizationId: u['organizationId'],
        },
      };
    }),
  });

  const client = {
    user: {
      findUnique: async ({ where }: { where: Where }) => {
        log.push('user.findUnique');
        return store.users.find((u) => u['id'] === where['id']) ?? null;
      },
      findFirst: async ({ where }: { where: Where }) => {
        log.push('user.findFirst');
        const u = store.users.find((x) => matches(x, where, userRelations));
        if (!u) return null;
        return { ...u, organization: store.orgs.find((o) => o.id === u['organizationId']) ?? null };
      },
      findMany: async ({ where }: { where: Where }) => {
        log.push('user.findMany');
        return store.users.filter((u) => matches(u, where, userRelations));
      },
    },
    chatRequest: {
      findUnique: async ({ where }: { where: Where }) => {
        log.push('chatRequest.findUnique');
        const key = where['requesterId_recipientEmail'] as Where | undefined;
        const row = key
          ? store.requests.find(
              (r) =>
                r['requesterId'] === key['requesterId'] &&
                r['recipientEmail'] === key['recipientEmail'],
            )
          : store.requests.find((r) => r['id'] === where['id']);
        if (!row) return null;
        const requester = store.users.find((u) => u['id'] === row['requesterId']);
        return { ...row, requester };
      },
      findFirst: async ({ where }: { where: Where }) => {
        log.push('chatRequest.findFirst');
        return store.requests.find((r) => matches(r, where, requestRelations)) ?? null;
      },
      findMany: async ({ where }: { where: Where }) => {
        log.push('chatRequest.findMany');
        return store.requests
          .filter((r) => matches(r, where, requestRelations))
          .map((r) => {
            const u = store.users.find((x) => x['id'] === r['requesterId'])!;
            const organization = store.orgs.find((o) => o.id === u['organizationId']) ?? null;
            return { ...r, requester: { ...u, organization } };
          });
      },
      create: async ({ data }: { data: Row }) => {
        log.push('chatRequest.create');
        writes.push('chatRequest.create');
        const row = {
          id: `cmnewrequest${String(nextId++).padStart(13, '0')}`,
          recipientId: null,
          status: 'PENDING',
          roomId: null,
          attemptCount: 1,
          respondedAt: null,
          ...data,
        };
        store.requests.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Where; data: Row }) => {
        log.push('chatRequest.update');
        writes.push('chatRequest.update');
        const row = store.requests.find((r) => r['id'] === where['id'])!;
        for (const [k, v] of Object.entries(data)) {
          row[k] =
            v && typeof v === 'object' && 'increment' in (v as Row)
              ? (row[k] as number) + (v as { increment: number }).increment
              : v;
        }
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        log.push('chatRequest.updateMany');
        const hit = store.requests.filter((r) => matches(r, where, requestRelations));
        for (const r of hit) Object.assign(r, data);
        if (hit.length > 0) writes.push('chatRequest.updateMany');
        return { count: hit.length };
      },
    },
    chatRequestBlock: {
      findUnique: async ({ where }: { where: Where }) => {
        log.push('chatRequestBlock.findUnique');
        const key = where['blockerId_blockedUserId'] as Where;
        return (
          store.blocks.find(
            (b) =>
              b['blockerId'] === key['blockerId'] && b['blockedUserId'] === key['blockedUserId'],
          ) ?? null
        );
      },
      findFirst: async ({ where }: { where: Where }) => {
        log.push('chatRequestBlock.findFirst');
        return store.blocks.find((b) => matches(b, where, {})) ?? null;
      },
      upsert: async ({ create }: { create: Row }) => {
        log.push('chatRequestBlock.upsert');
        writes.push('chatRequestBlock.upsert');
        const found = store.blocks.find(
          (b) =>
            b['blockerId'] === create['blockerId'] &&
            b['blockedUserId'] === create['blockedUserId'],
        );
        const row = found ?? { id: `cmblock${nextId++}`, createdAt: new Date(), ...create };
        if (!found) store.blocks.push(row);
        const blocked = store.users.find((u) => u['id'] === row['blockedUserId']);
        return { ...row, blocked };
      },
    },
    chatRoom: {
      findUnique: async ({ where }: { where: Where }) => {
        log.push('chatRoom.findUnique');
        const room = store.rooms.find((r) => r.id === where['id']);
        return room ? roomRow(room) : null;
      },
      findFirst: async ({ where }: { where: Where }) => {
        log.push('chatRoom.findFirst');
        const room = store.rooms.find((r) => r.id === where['id']);
        if (!room) return null;
        if (where['type'] && where['type'] !== room.type) return null;
        return roomRow(room);
      },
      findMany: async ({ where }: { where: Where }) => {
        log.push('chatRoom.findMany');
        return store.rooms
          .filter((r) => matches(r as unknown as Row, where, roomRelations))
          .map(roomRow);
      },
      create: async ({ data }: { data: Row }) => {
        log.push('chatRoom.create');
        writes.push('chatRoom.create');
        const parts = (
          (data['participants'] as Row)['createMany'] as {
            data: Array<{ userId: string; role: string }>;
          }
        ).data;
        const room = {
          id: `cmnewroom${String(nextId++).padStart(16, '0')}`,
          type: data['type'] as string,
          workspaceId: null,
          createdById: (data['createdById'] as string) ?? null,
          participants: parts.map((p, i) => ({
            id: `cmpart${i}${nextId}`,
            userId: p.userId,
            role: p.role,
          })),
        };
        store.rooms.push(room);
        return roomRow(room);
      },
      update: async ({ where }: { where: Where }) => {
        log.push('chatRoom.update');
        writes.push('chatRoom.update');
        return roomRow(store.rooms.find((r) => r.id === where['id'])!);
      },
    },
    chatRoomParticipant: {
      findMany: async ({ where }: { where: Where }) => {
        log.push('chatRoomParticipant.findMany');
        const room = store.rooms.find((r) => r.id === where['roomId']);
        return room ? room.participants.map((p) => ({ userId: p.userId, role: p.role })) : [];
      },
    },
    chatRoomMessage: {
      update: async ({ where, data }: { where: Where; data: Row }) => {
        log.push('chatRoomMessage.update');
        writes.push('chatRoomMessage.update');
        const row = store.messages.find((m) => m['id'] === where['id'])!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        log.push('chatRoomMessage.updateMany');
        writes.push('chatRoomMessage.updateMany');
        const hit = store.messages.filter((m) => m['roomId'] === where['roomId']);
        for (const m of hit) Object.assign(m, data);
        return { count: hit.length };
      },
      create: async ({ data }: { data: Row }) => {
        log.push('chatRoomMessage.create');
        writes.push('chatRoomMessage.create');
        const row = {
          id: `cmnewmsg${String(nextId++).padStart(17, '0')}`,
          status: 'SENT',
          createdAt: new Date(),
          editedAt: null,
          deletedAt: null,
          parentMessageId: null,
          parentMessage: null,
          reactions: [],
          ...data,
          attachments: [],
        };
        store.messages.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Where }) => {
        log.push('chatRoomMessage.findFirst');
        return store.messages.find((m) => m['id'] === where['id'] && !m['deletedAt']) ?? null;
      },
      findMany: async ({ where }: { where: Where }) => {
        log.push('chatRoomMessage.findMany');
        const ids = (where['id'] as { in: string[] }).in;
        return store.messages.filter((m) => ids.includes(m['id'] as string));
      },
    },
    $transaction: async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(client);
      return Promise.all(arg as Array<Promise<unknown>>);
    },
  };
  return { prisma: { client } as unknown as PrismaService, log, writes };
}

function fakeRedis() {
  const counters = new Map<string, number>();
  const redis = {
    client: {
      incr: async (key: string) => {
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return n;
      },
      expire: async () => 1,
    },
  };
  return redis as unknown as RedisService;
}

function fakeNotifications() {
  const emitted: Array<Record<string, unknown>> = [];
  const svc = {
    emit: async (args: Record<string, unknown>) => {
      emitted.push(args);
      return { id: 'cmnotification' };
    },
    emitMany: async () => undefined,
  };
  return { notifications: svc as unknown as NotificationsService, emitted };
}

function build(store: Store) {
  const fp = fakePrisma(store);
  const { notifications, emitted } = fakeNotifications();
  const chat = new ChatService(fp.prisma, notifications);
  const requests = new ChatRequestsService(fp.prisma, fakeRedis(), notifications, chat);
  return { ...fp, chat, requests, emitted };
}

const flushImmediates = () =>
  new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)));

const status =
  (code: number) =>
  (err: unknown): boolean =>
    err instanceof HttpException && err.getStatus() === code;

const senderCaller = {
  id: SENDER,
  name: 'Sender',
  email: `${SENDER}@example.test`,
  organizationId: ORG_A,
};
const meCaller = { id: ME, name: 'Me', email: MY_EMAIL, organizationId: ORG_B };

async function main(): Promise<void> {
  // --- 1. send: no user reads, known == unknown ---------------------------------
  {
    const known = build(seedStore());
    const resKnown = await known.requests.send(senderCaller, {
      email: MY_EMAIL,
      message: 'Hi there',
    });
    const knownLog = [...known.log];

    const unknown = build(seedStore());
    const resUnknown = await unknown.requests.send(senderCaller, {
      email: 'nobody@nowhere.test',
      message: 'Hi there',
    });
    const unknownLog = [...unknown.log];

    assert.ok(!knownLog.some((q) => q.startsWith('user.')), 'send reads no user before answering');
    assert.deepEqual(
      knownLog,
      ['chatRequest.findUnique', 'chatRequest.create'],
      'one read + one write',
    );
    assert.deepEqual(unknownLog, knownLog, 'known and unknown address: same queries');
    const normalize = (r: typeof resKnown) => ({
      ...r,
      request: { ...r.request, email: '<email>', sentAt: '<sentAt>' },
    });
    assert.deepEqual(
      normalize(resKnown),
      normalize(resUnknown),
      'known and unknown: same response',
    );
    assert.equal(resKnown.notice, CHAT_REQUEST_SENT_NOTICE);
    assert.equal(resKnown.request.state, 'SENT');

    // Delivery runs afterwards: the known address gets exactly one bell row.
    await flushImmediates();
    assert.equal(known.emitted.length, 1, 'known address is notified after the response');
    assert.equal(known.emitted[0]!['userId'], ME);
    assert.equal(known.emitted[0]!['type'], 'CHAT_REQUEST');
    assert.equal(unknown.emitted.length, 0, 'unknown address notifies nobody');

    // A repeat send while pending is one read + one write too, and silent.
    known.log.length = 0;
    await known.requests.send(senderCaller, { email: MY_EMAIL, message: 'again' });
    assert.deepEqual(
      known.log,
      ['chatRequest.findUnique', 'chatRequest.update'],
      'repeat: read + write',
    );
    await flushImmediates();
    assert.equal(known.emitted.length, 1, 'a fresh pending request is not re-delivered');

    // Org-less callers are refused on the caller alone.
    await assert.rejects(
      known.requests.send(
        { ...senderCaller, organizationId: null },
        { email: MY_EMAIL, message: 'x' },
      ),
      (err: unknown) => err instanceof ForbiddenException,
      'org-less caller is a 403',
    );

    // Same-org and blocked recipients are skipped at delivery, silently.
    for (const [rid, orgId, why] of [
      [REQ_SAME, ORG_B, 'a same-org recipient'],
      [REQ_BLOCKED, ORG_A, 'a recipient who blocked the sender'],
    ] as const) {
      const store = seedStore();
      store.requests = [];
      const t = build(store);
      await t.requests.send(
        { id: rid, name: 'R', email: `${rid}@example.test`, organizationId: orgId },
        { email: MY_EMAIL, message: 'x' },
      );
      await flushImmediates();
      assert.equal(t.emitted.length, 0, `${why} is never notified`);
    }
  }

  // --- 2. rate limit -----------------------------------------------------------
  {
    const t = build(seedStore());
    for (let i = 0; i < 10; i++) {
      await t.requests.send(senderCaller, { email: `p${i}@x.test`, message: 'hi' });
    }
    const before = t.writes.length;
    await assert.rejects(
      t.requests.send(senderCaller, { email: 'p10@x.test', message: 'hi' }),
      status(429),
      '11th send in an hour is a 429',
    );
    assert.equal(t.writes.length, before, 'the refused send writes nothing');
    await flushImmediates();
  }

  // --- 3. incoming + accept --------------------------------------------------------
  {
    const t = build(seedStore());
    const incoming = await t.requests.listIncoming(meCaller);
    assert.deepEqual(
      incoming.items.map((i) => i.requester.id),
      [REQ_OK],
      'incoming hides blocked, same-org, client and suspended-org requesters',
    );
    assert.equal(incoming.items[0]!.requester.organizationName, 'Company A');
    assert.ok(!('organizationId' in incoming.items[0]!.requester), 'org id never exposed');

    for (const [rid, why] of [
      [REQ_BLOCKED, 'blocked'],
      [REQ_SAME, 'same-org'],
      [REQ_CLIENT, 'client account'],
      [REQ_SUSP, 'suspended org'],
    ] as const) {
      await assert.rejects(
        t.requests.accept(meCaller, requestIdOf(rid)),
        (err: unknown) => err instanceof NotFoundException,
        `accept refuses a ${why} requester`,
      );
    }
    assert.deepEqual(t.writes, [], 'refused accepts write nothing');

    const result = await t.requests.accept(meCaller, requestIdOf(REQ_OK));
    assert.equal(result.room.type, 'DM');
    assert.deepEqual(
      result.room.participants.map((p) => [p.userId, p.role]).sort(),
      [
        [ME, 'MEMBER'],
        [REQ_OK, 'ADMIN'],
      ].sort(),
      'DM between requester (admin) and recipient',
    );
    assert.equal(result.message.senderId, REQ_OK, 'first message is from the requester');
    assert.equal(result.message.content, `hello from ${REQ_OK}`, 'first message is the request');
    assert.equal(t.emitted.at(-1)?.['userId'], REQ_OK, 'requester is told about the accept');
    assert.match(
      String(t.emitted.at(-1)?.['title']),
      /\(Company B\) accepted your chat request/,
      "the accept notice names the accepter's organization",
    );
    assert.equal(result.room.spansOrganizations, true, 'the DM is flagged as cross-org');

    // Sequential second accept: no longer visible -> 404.
    await assert.rejects(
      t.requests.accept(meCaller, requestIdOf(REQ_OK)),
      (err: unknown) => err instanceof NotFoundException,
      'accepting an answered request is a 404',
    );

    // Racing accepts: both pass the lookup, only one claims it.
    const race = build(seedStore());
    const outcomes = await Promise.allSettled([
      race.requests.accept(meCaller, requestIdOf(REQ_OK)),
      race.requests.accept(meCaller, requestIdOf(REQ_OK)),
    ]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'one accept wins');
    const lost = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    assert.ok(lost.reason instanceof ConflictException, 'the second accept is a 409');
    assert.equal(race.writes.filter((w) => w === 'chatRoom.create').length, 1, 'one DM created');
  }

  // --- 4. ChatService boundaries ---------------------------------------------------
  {
    const store = seedStore();
    const t = build(store);
    await assert.rejects(
      t.chat.createRoom(SENDER, { type: 'DM', participantUserIds: [ME] } as never, null),
      (err: unknown) => err instanceof ForbiddenException,
      'createRoom still refuses a cross-org DM',
    );
    assert.deepEqual(t.writes, [], 'refused createRoom writes nothing');

    store.rooms.push(
      {
        id: ROOM_X,
        type: 'DM',
        workspaceId: null,
        createdById: SENDER,
        participants: [
          { id: 'cmpx1', userId: SENDER, role: 'ADMIN' },
          { id: 'cmpx2', userId: ME, role: 'MEMBER' },
        ],
      },
      {
        id: ROOM_SAME,
        type: 'GROUP',
        workspaceId: null,
        createdById: SENDER,
        participants: [
          { id: 'cmps1', userId: SENDER, role: 'ADMIN' },
          { id: 'cmps2', userId: REQ_OK, role: 'MEMBER' },
        ],
      },
    );
    store.messages.push({
      id: MSG_SAME,
      roomId: ROOM_SAME,
      senderId: REQ_OK,
      content: 'internal',
      attachments: [],
    });

    await assert.rejects(
      t.chat.shareToChat(SENDER, ROOM_X, 'task', 'cmtask000000000000000000'),
      (err: unknown) => err instanceof NotFoundException,
      'share into a cross-org DM is a 404',
    );
    await assert.rejects(
      t.chat.forwardMessages(SENDER, [MSG_SAME], ROOM_X),
      (err: unknown) =>
        err instanceof ForbiddenException &&
        /another organization/.test(String((err.getResponse() as { title?: string }).title)),
      'forward into a cross-org DM from another room is a 403',
    );
    assert.deepEqual(t.writes, [], 'refused share / forward write nothing');

    // Blocking from the DM needs a shared cross-org DM; anyone else is a 404.
    await assert.rejects(
      t.requests.block(meCaller, REQ_OK),
      (err: unknown) => err instanceof NotFoundException,
      'block without a shared cross-org DM is a 404',
    );
    await assert.rejects(
      t.requests.block(
        { id: SENDER, name: 'S', email: `${SENDER}@example.test`, organizationId: ORG_A },
        REQ_OK,
      ),
      (err: unknown) => err instanceof NotFoundException,
      'block over a same-org room is a 404',
    );
    assert.ok(
      !(t.writes as string[]).includes('chatRequestBlock.upsert'),
      'refused blocks write nothing',
    );

    // Messages flow until someone blocks, then stop in both directions.
    const first = await t.chat.sendMessage(SENDER, { roomId: ROOM_X, content: 'hi' } as never);
    const blocked = await t.requests.block(meCaller, SENDER);
    assert.equal(blocked.user.id, SENDER, 'block from the DM header');
    await assert.rejects(
      t.chat.forwardMessages(SENDER, [first.id], ROOM_X),
      (err: unknown) => err instanceof ForbiddenException,
      'a blocked person cannot forward into the DM, even from the DM itself',
    );
    await assert.rejects(
      t.chat.initiateCall(SENDER, 'socket-1', ROOM_X),
      (err: unknown) => err instanceof ForbiddenException,
      'a blocked person cannot call',
    );
    await assert.rejects(
      t.chat.initiateCall(ME, 'socket-2', ROOM_X),
      (err: unknown) => err instanceof ForbiddenException,
      'the blocker cannot call either',
    );
    await assert.rejects(
      t.chat.editMessage(SENDER, first.id, 'edited after the block'),
      (err: unknown) => err instanceof ForbiddenException,
      'a blocked person cannot edit old messages',
    );
    for (const who of [SENDER, ME]) {
      await assert.rejects(
        t.chat.toggleReaction(who, first.id, '{1F44D}'),
        (err: unknown) => err instanceof ForbiddenException,
        'nobody can react across a block',
      );
    }
    const livekit = new LivekitService(t.prisma, { get: () => 'x' } as never);
    await assert.rejects(
      livekit.mintToken(SENDER, { roomId: ROOM_X, kind: 'call' } as never),
      (err: unknown) => err instanceof ForbiddenException,
      'no call token across a block',
    );
    assert.ok(
      !(t.writes as string[]).some((w) => w.startsWith('chatRoomMessageReaction')),
      'refused edits and reactions write nothing',
    );
    await assert.rejects(
      t.chat.sendMessage(SENDER, { roomId: ROOM_X, content: 'hi again' } as never),
      (err: unknown) => err instanceof ForbiddenException,
      'blocked sender cannot message the cross-org DM',
    );
    await assert.rejects(
      t.chat.sendMessage(ME, { roomId: ROOM_X, content: 'hi' } as never),
      (err: unknown) => err instanceof ForbiddenException,
      'the blocker cannot message the blocked person either',
    );
    await flushImmediates();
  }

  // --- 5. decline & block, cancel, outgoing view ---------------------------------
  {
    const store = seedStore();
    const t = build(store);
    await t.requests.decline(meCaller, requestIdOf(REQ_OK), { block: true });
    const row = store.requests.find((r) => r['id'] === requestIdOf(REQ_OK))!;
    assert.equal(row['status'], 'DECLINED');
    assert.ok(
      store.blocks.some((b) => b['blockerId'] === ME && b['blockedUserId'] === REQ_OK),
      'block recorded',
    );
    const reqCaller = {
      id: REQ_OK,
      name: 'R',
      email: `${REQ_OK}@example.test`,
      organizationId: ORG_A,
    };
    const outgoing = await t.requests.listOutgoing(reqCaller);
    assert.equal(outgoing.items[0]!.state, 'SENT', 'a decline still reads as sent');

    // Cancel + resend inside the decline cool-down: looks reopened, stays quiet.
    await t.requests.cancel(reqCaller, requestIdOf(REQ_OK));
    const again = await t.requests.send(reqCaller, { email: MY_EMAIL, message: 'once more' });
    assert.equal(again.request.state, 'SENT');
    assert.equal(row['status'], 'DECLINED', 'cancel + resend does not skip the decline cool-down');
    await flushImmediates();
  }

  // --- 6. a repeat send never reveals a decline ---------------------------------
  {
    const existing = (extra: Row): Row => ({
      id: 'cmexistingrequest00000000',
      requesterId: SENDER,
      recipientEmail: MY_EMAIL,
      recipientId: null,
      message: 'earlier message',
      roomId: null,
      attemptCount: 1,
      ...extra,
    });
    const sendWith = async (row: Row | null, email: string) => {
      const store = seedStore();
      store.requests = row ? [row] : [];
      const t = build(store);
      const res = await t.requests.send(senderCaller, { email, message: 'new message' });
      await flushImmediates();
      return { res, store, emitted: t.emitted };
    };
    const shape = (r: Awaited<ReturnType<typeof sendWith>>['res']) => ({
      ...r,
      request: { ...r.request, id: '<id>', email: '<email>' },
    });
    const fresh = (d: Date) => now.getTime() - d.getTime() < 60_000;

    // A: sent day 0, declined day 20, re-sent day 35.
    const unknownA = await sendWith(null, 'nobody@nowhere.test');
    const declinedA = await sendWith(
      existing({ status: 'DECLINED', sentAt: daysAgo(35), respondedAt: daysAgo(15) }),
      MY_EMAIL,
    );
    const expiredA = await sendWith(
      existing({ status: 'PENDING', sentAt: daysAgo(35), respondedAt: null }),
      MY_EMAIL,
    );
    for (const [label, r] of [
      ['unknown', unknownA],
      ['declined', declinedA],
      ['expired', expiredA],
    ] as const) {
      assert.equal(r.res.request.state, 'SENT', `A/${label}: reads as sent`);
      assert.ok(fresh(r.res.request.sentAt), `A/${label}: new sentAt`);
      assert.equal(r.res.request.message, 'new message', `A/${label}: new message`);
    }
    const normA = (r: typeof unknownA) => ({
      ...shape(r.res),
      request: { ...shape(r.res).request, sentAt: '<now>' },
    });
    assert.deepEqual(normA(declinedA), normA(unknownA), 'A: declined address == unknown address');
    assert.deepEqual(normA(expiredA), normA(unknownA), 'A: expired address == unknown address');
    assert.equal(
      declinedA.store.requests[0]!['status'],
      'DECLINED',
      'A: still declined underneath',
    );
    assert.equal(declinedA.emitted.length, 0, 'A: inside the cool-down, nothing is delivered');
    assert.equal(
      expiredA.emitted.length,
      1,
      'A: an expired, never-declined request is re-delivered',
    );

    // B: declined day 1, cancel + resend day 10 (quiet), resend day 35.
    const declinedB = await sendWith(
      existing({ status: 'DECLINED', sentAt: daysAgo(25), respondedAt: daysAgo(34) }),
      MY_EMAIL,
    );
    const pendingB = await sendWith(
      existing({ status: 'PENDING', sentAt: daysAgo(25), respondedAt: null }),
      MY_EMAIL,
    );
    assert.deepEqual(shape(declinedB.res), shape(pendingB.res), 'B: declined == never declined');
    assert.equal(declinedB.res.request.message, 'earlier message', 'B: still the earlier request');
    assert.equal(declinedB.emitted.length + pendingB.emitted.length, 0, 'B: neither re-delivered');
  }

  // --- 7. requests never reach an account created after they were sent -------
  {
    const store = seedStore();
    // The address was claimed (self-signup, or an admin minting it) after
    // every seeded request was sent.
    store.users.find((u) => u['id'] === ME)!['createdAt'] = new Date();
    const t = build(store);
    assert.deepEqual((await t.requests.listIncoming(meCaller)).items, [], 'never listed');
    await assert.rejects(
      t.requests.accept(meCaller, requestIdOf(REQ_OK)),
      (err: unknown) => err instanceof NotFoundException,
      'never accepted',
    );
    await assert.rejects(
      t.requests.decline(meCaller, requestIdOf(REQ_OK), { block: false }),
      (err: unknown) => err instanceof NotFoundException,
      'never declined',
    );
    await t.requests.deliver(requestIdOf(REQ_OK));
    assert.equal(t.emitted.length, 0, 'never delivered');
    assert.deepEqual(t.writes, [], 'nothing written for the newer account');
  }

  // --- 8. no moderation across organizations ----------------------------------
  {
    const store = seedStore();
    const CLIENT_NOORG = 'cmclientnoorg000000000000';
    const ROOM_NOORG = 'cmroomnoorg00000000000000';
    store.users.push(user(CLIENT_NOORG, null, { accountType: 'CLIENT' }));
    store.rooms.push(
      {
        // Opened from SENDER's accepted request: SENDER is ADMIN.
        id: ROOM_X,
        type: 'DM',
        workspaceId: null,
        createdById: SENDER,
        participants: [
          { id: 'cmpx1', userId: SENDER, role: 'ADMIN' },
          { id: 'cmpx2', userId: ME, role: 'MEMBER' },
        ],
      },
      {
        id: ROOM_SAME,
        type: 'GROUP',
        workspaceId: null,
        createdById: SENDER,
        participants: [
          { id: 'cmps1', userId: SENDER, role: 'ADMIN' },
          { id: 'cmps2', userId: REQ_OK, role: 'MEMBER' },
        ],
      },
      {
        id: ROOM_NOORG,
        type: 'DM',
        workspaceId: null,
        createdById: SENDER,
        participants: [
          { id: 'cmpn1', userId: SENDER, role: 'ADMIN' },
          { id: 'cmpn2', userId: CLIENT_NOORG, role: 'MEMBER' },
        ],
      },
    );
    const msg = (id: string, senderId: string): Row => ({
      id,
      roomId: ROOM_X,
      senderId,
      content: id,
      deletedAt: null,
      attachments: [],
    });
    store.messages.push(
      msg('cmmsgfromme00000000000000', ME),
      msg('cmmsgfromsender0000000000', SENDER),
    );
    const t = build(store);

    await assert.rejects(
      t.chat.deleteMessage(SENDER, 'cmmsgfromme00000000000000'),
      (err: unknown) => err instanceof ForbiddenException,
      "the DM's admin cannot delete the other org's message",
    );
    await assert.rejects(
      t.chat.deleteAllRoomMessages(SENDER, ROOM_X),
      (err: unknown) => err instanceof ForbiddenException,
      'nobody can clear a cross-org DM',
    );
    assert.deepEqual(t.writes, [], 'refused deletes write nothing');
    await t.chat.deleteMessage(ME, 'cmmsgfromme00000000000000');
    await t.chat.deleteMessage(SENDER, 'cmmsgfromsender0000000000');
    assert.ok(
      store.messages.every((m) => m['deletedAt'] instanceof Date),
      'each side can still delete their own messages',
    );

    // Org admin tools: only rooms whose every participant is in the org.
    const actor = { systemRole: 'ADMIN', organizationId: ORG_A };
    const listed = await t.chat.listAdminRoomsForWorkspace('cmwsa0000000000000000000a', actor);
    assert.deepEqual(
      listed.items.map((r) => r.id),
      [ROOM_SAME],
      'admin listing skips the cross-org DM and the DM with an org-less account',
    );
    for (const roomId of [ROOM_X, ROOM_NOORG]) {
      await assert.rejects(
        t.chat.adminDeleteRoom(roomId, actor),
        (err: unknown) => err instanceof NotFoundException,
        'admin delete cannot reach a room spanning organizations',
      );
    }
    await t.chat.adminDeleteRoom(ROOM_SAME, actor);
    assert.ok(
      (t.writes as string[]).includes('chatRoom.update'),
      'an all-own-org room can still be deleted',
    );
  }

  console.log('check-chat-requests: OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
