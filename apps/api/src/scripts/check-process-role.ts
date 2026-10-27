/**
 * Process roles (ROLE=all|api|worker), no database or Redis needed:
 *
 *  1. ROLE parsing: unset/blank is `all`, known values are accepted, anything
 *     else fails with a clear message.
 *  2. What runs per role, on the real libraries: @Cron/@Interval/@Timeout
 *     (the real IDLE supervisors and crons included) are off in `api`, and
 *     BullMQ registers no Worker in `api`.
 *  3. Boot-time work (IMAP IDLE, attendance backfill, SMTP verify) runs only
 *     in `all` and `worker`.
 *  4. Cross-process events: `all` never touches Redis; `worker` publishes;
 *     `api` publishes, receives, skips its own messages, and feeds received
 *     notifications / pushes / mail events / socket broadcasts to its local
 *     subscribers with the same shapes (Dates revived).
 *  5. Worker presence guard and health server.
 *  6. The real QueueModule / AppModule options, read in child processes
 *     started with ROLE=api, ROLE=all and no ROLE.
 *
 * Run: pnpm --filter @botss/api test.
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { BullRegistrar } from '@nestjs/bullmq';
import { BULL_EXTRA_OPTIONS_TOKEN } from '@nestjs/bullmq/dist/bull.constants';
import { Injectable, type LogLevel, Logger } from '@nestjs/common';
import { Cron, Interval, ScheduleModule, SchedulerRegistry, Timeout } from '@nestjs/schedule';
import { NestFactory } from '@nestjs/core';

import { ChatGateway } from '../chat/chat.gateway';
import {
  bullExtraOptionsForRole,
  getProcessRole,
  InvalidProcessRoleError,
  isSplitRole,
  parseProcessRole,
  PROCESS_ROLES,
  type ProcessRole,
  runsBackgroundWork,
  scheduleOptionsForRole,
  servesHttp,
} from '../common/process-role';
import { EmailModule, getSharedMailSender } from '../email/email.module';
import { startWorkerHealthServer, parseWorkerHealthPort } from '../health/worker-health-server';
import { AttendanceCronService } from '../hr/attendance-cron.service';
import { AttendanceService } from '../hr/attendance.service';
import { TimesheetWarningCronService } from '../hr/timesheet-warning-cron.service';
import { LeadFollowupCronService } from '../leads/lead-followup-cron.service';
import { ImapIdleService } from '../mail/imap-idle.service';
import { MAIL_EVENT_TOPIC, MailEventsService, type MailEvent } from '../mail/mail-events.service';
import {
  RealtimeEventsService,
  type RealtimeNotificationEvent,
} from '../notifications/realtime-events.service';
import { busChannelPrefix, CrossProcessBus } from '../redis/cross-process-bus.service';
import {
  liveMembersWithRole,
  PRESENCE_KEY,
  PRESENCE_STALE_MS,
  type PresenceReader,
  presenceMember,
  ProcessPresenceService,
  waitForNoLiveAllProcess,
} from '../redis/process-presence.service';
import type { RedisService } from '../redis/redis.service';

// Keep the output readable: the services under test log on purpose.
Logger.overrideLogger(['error'] satisfies LogLevel[]);

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function main(): Promise<void> {
  // ---- 1. Parsing -----------------------------------------------------------
  assert.equal(parseProcessRole(undefined), 'all');
  assert.equal(parseProcessRole(''), 'all');
  assert.equal(parseProcessRole('   '), 'all');
  assert.equal(parseProcessRole('all'), 'all');
  assert.equal(parseProcessRole('api'), 'api');
  assert.equal(parseProcessRole(' Worker '), 'worker');
  for (const bad of ['workers', 'web', 'both', '1', 'api,worker']) {
    assert.throws(
      () => parseProcessRole(bad),
      (e: unknown) =>
        e instanceof InvalidProcessRoleError &&
        e.message.includes(JSON.stringify(bad)) &&
        e.message.includes('all, api, worker'),
      `ROLE=${bad} must fail with a clear message`,
    );
  }
  console.log('  ok  ROLE parsing (unset = all, invalid fails fast)');

  const table: Record<ProcessRole, [boolean, boolean, boolean]> = {
    all: [true, true, false],
    api: [true, false, true],
    worker: [false, true, true],
  };
  for (const role of PROCESS_ROLES) {
    const [http, background, split] = table[role];
    assert.equal(servesHttp(role), http, `${role} http`);
    assert.equal(runsBackgroundWork(role), background, `${role} background`);
    assert.equal(isSplitRole(role), split, `${role} split`);
    assert.deepEqual(scheduleOptionsForRole(role), {
      cronJobs: background,
      intervals: background,
      timeouts: background,
    });
    assert.deepEqual(bullExtraOptionsForRole(role), { manualRegistration: !background });
  }
  console.log('  ok  capability table per role');

  // ---- 2a. Schedulers on the real @nestjs/schedule --------------------------
  @Injectable()
  class Probe {
    @Cron('0 0 1 1 *', { name: 'probe-cron' })
    cron(): void {}
    @Interval('probe-interval', 3_600_000)
    interval(): void {}
    @Timeout('probe-timeout', 3_600_000)
    timeout(): void {}
  }
  const noDb = new Proxy(
    {},
    {
      get: () => {
        throw new Error('this check must not reach the database');
      },
    },
  );
  const fakePrisma = {
    client: { mailAccount: { findMany: async () => [] } },
  };
  for (const role of PROCESS_ROLES) {
    class RoleProbeModule {}
    const moduleRef = await NestFactory.createApplicationContext(
      {
        module: RoleProbeModule,
        imports: [ScheduleModule.forRoot(scheduleOptionsForRole(role))],
      providers: [
        Probe,
        { provide: AttendanceCronService, useValue: new AttendanceCronService(noDb as never) },
        {
          provide: TimesheetWarningCronService,
          useValue: new TimesheetWarningCronService(noDb as never),
        },
        { provide: LeadFollowupCronService, useValue: new LeadFollowupCronService(noDb as never) },
        {
          provide: ImapIdleService,
          // Role 'api' here so its boot refresh never runs; this part only
          // looks at which @Interval timers the scheduler mounts.
          useValue: new ImapIdleService(fakePrisma as never, {} as never, {} as never, 'api'),
        },
      ],
      },
      { logger: false },
    );
    const registry = moduleRef.get(SchedulerRegistry);
    const crons = [...registry.getCronJobs().keys()].sort();
    const intervals = registry.getIntervals().sort();
    const timeouts = registry.getTimeouts().sort();
    if (runsBackgroundWork(role)) {
      assert.deepEqual(crons, [
        'daily-attendance',
        'lead-followup-reminders',
        'probe-cron',
        'timesheet-warnings',
      ]);
      assert.deepEqual(intervals, ['imap-idle-supervisor', 'mail-backstop', 'probe-interval']);
      assert.deepEqual(timeouts, ['probe-timeout']);
    } else {
      assert.deepEqual(crons, [], 'api runs no cron');
      assert.deepEqual(intervals, [], 'api runs no interval (IDLE supervisor, mail backstop)');
      assert.deepEqual(timeouts, [], 'api runs no timeout');
    }
    await moduleRef.close();
  }
  console.log('  ok  crons/intervals/timeouts: all + worker run them, api runs none');

  // ---- 2b. BullMQ workers on the real registrar ------------------------------
  for (const role of PROCESS_ROLES) {
    let registered = 0;
    const explorer = { register: () => void registered++ };
    const moduleRef = { get: () => bullExtraOptionsForRole(role) };
    new BullRegistrar(moduleRef as never, explorer as never).onModuleInit();
    assert.equal(registered, runsBackgroundWork(role) ? 1 : 0, `${role}: BullMQ worker registration`);
  }
  console.log('  ok  BullMQ @Processor workers: registered in all + worker, never in api');

  // ---- 3. Boot-time work -----------------------------------------------------
  for (const role of PROCESS_ROLES) {
    let lookups = 0;
    const prisma = {
      client: {
        mailAccount: {
          findMany: async () => {
            lookups++;
            return [];
          },
        },
      },
    };
    const idle = new ImapIdleService(prisma as never, {} as never, {} as never, role);
    assert.equal(idle.ownsWatchers, runsBackgroundWork(role));
    await idle.refreshWatchers();
    await idle.supervise();
    assert.equal(lookups, runsBackgroundWork(role) ? 2 : 0, `${role}: IDLE reconcile`);
    await idle.onModuleDestroy();

    const attendance = new AttendanceService(noDb as never, {} as never, {} as never, role);
    let backfills = 0;
    attendance.backfillAttendanceFromTimeEntries = async () => {
      backfills++;
      return 0;
    };
    attendance.onApplicationBootstrap();
    await tick();
    assert.equal(backfills, runsBackgroundWork(role) ? 1 : 0, `${role}: attendance backfill`);

    const sender = getSharedMailSender();
    const original = { isStub: sender.isStub, verify: sender.verify };
    let verifies = 0;
    sender.isStub = () => false;
    sender.verify = async () => {
      verifies++;
      return { ok: true } as Awaited<ReturnType<typeof original.verify>>;
    };
    const skip = process.env.SMTP_SKIP_VERIFY;
    delete process.env.SMTP_SKIP_VERIFY;
    try {
      await new EmailModule(role).onApplicationBootstrap();
    } finally {
      sender.isStub = original.isStub;
      sender.verify = original.verify;
      if (skip !== undefined) process.env.SMTP_SKIP_VERIFY = skip;
    }
    assert.equal(verifies, runsBackgroundWork(role) ? 1 : 0, `${role}: boot SMTP verify`);
  }
  console.log('  ok  IMAP IDLE, attendance backfill, SMTP verify: all + worker only');

  // ---- 4. Cross-process bus --------------------------------------------------
  type Published = { channel: string; message: string };
  const fakeRedis = (db: number, out: Published[]): RedisService =>
    ({
      client: {
        options: { db },
        status: 'ready',
        publish: async (channel: string, message: string) => {
          out.push({ channel, message });
          return 1;
        },
      },
    }) as unknown as RedisService;

  {
    const out: Published[] = [];
    const bus = new CrossProcessBus(fakeRedis(0, out), 'all');
    assert.equal(bus.publishes, false);
    assert.equal(bus.receives, false);
    const events = new RealtimeEventsService(bus);
    const got: RealtimeNotificationEvent[] = [];
    events.notifications$.subscribe((e) => got.push(e));
    events.publishNotification(sampleNotification());
    await tick();
    assert.equal(got.length, 1, 'all: delivered in-process as before');
    assert.equal(out.length, 0, 'all: nothing goes to Redis');
  }

  {
    // Worker -> api over the bus, for every topic.
    const wire: Published[] = [];
    const workerBus = new CrossProcessBus(fakeRedis(1, wire), 'worker');
    const apiBus = new CrossProcessBus(fakeRedis(1, []), 'api');
    assert.equal(workerBus.publishes, true);
    assert.equal(workerBus.receives, false);
    assert.equal(apiBus.publishes, true);
    assert.equal(apiBus.receives, true);

    const workerEvents = new RealtimeEventsService(workerBus);
    const workerMail = new MailEventsService(workerBus);
    const apiEvents = new RealtimeEventsService(apiBus);
    const apiMail = new MailEventsService(apiBus);

    const notifications: RealtimeNotificationEvent[] = [];
    const revoked: string[][] = [];
    const mail: MailEvent[] = [];
    apiEvents.notifications$.subscribe((e) => notifications.push(e));
    apiEvents.sessionsRevoked$.subscribe((e) => revoked.push(e.userIds));
    apiMail.forUser('u1').subscribe((e) => mail.push(e));
    const pushes: unknown[] = [];
    apiEvents.pushes$.subscribe((e) => pushes.push(e));

    const sent = sampleNotification();
    workerEvents.publishNotification(sent);
    workerEvents.publishSessionsRevoked(['u1', 'u2']);
    workerMail.emit({ kind: 'folder-updated', userId: 'u1', accountId: 'a1', folderId: 'f1', inserted: 2 });
    workerMail.emit({ kind: 'folder-updated', userId: 'other', accountId: 'a2', folderId: 'f2', inserted: 1 });
    const push = {
      userIds: ['u1'],
      payload: { title: 'Hi', body: 'There', type: 'generic' as const, url: '/inbox', pushId: 'p1' },
    };
    workerEvents.publishPush(push);
    await tick();

    assert.equal(wire.length, 5, 'worker published every event to Redis');
    for (const w of wire) assert.ok(w.channel.startsWith(busChannelPrefix(1)), 'channel carries the db');
    assert.notEqual(busChannelPrefix(0), busChannelPrefix(1), 'staging and production never share channels');

    for (const w of wire) apiBus.dispatch(w.channel, w.message);
    // A message from another Redis db's environment is ignored.
    apiBus.dispatch(wire[0]!.channel.replace(busChannelPrefix(1), busChannelPrefix(0)), wire[0]!.message);
    await tick();
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], sent, 'notification arrives with the same shape');
    assert.ok(notifications[0]!.notification.createdAt instanceof Date, 'createdAt revived as a Date');
    assert.deepEqual(revoked, [['u1', 'u2']]);
    assert.deepEqual(mail, [
      { kind: 'folder-updated', userId: 'u1', accountId: 'a1', folderId: 'f1', inserted: 2 },
    ]);
    assert.deepEqual(pushes, [push], 'OS push reaches the api sockets');

    // Its own messages are never handled twice.
    const apiWire: Published[] = [];
    const selfBus = new CrossProcessBus(fakeRedis(0, apiWire), 'api');
    const selfEvents = new RealtimeEventsService(selfBus);
    const selfGot: RealtimeNotificationEvent[] = [];
    selfEvents.notifications$.subscribe((e) => selfGot.push(e));
    selfEvents.publishNotification(sampleNotification());
    for (const w of apiWire) selfBus.dispatch(w.channel, w.message);
    await tick();
    assert.equal(selfGot.length, 1, 'api: local delivery once, own Redis echo skipped');

    // Malformed payloads are dropped, never thrown.
    apiBus.dispatch(`${busChannelPrefix(1)}notifications`, 'not json');
    apiBus.dispatch(
      `${busChannelPrefix(1)}notifications`,
      JSON.stringify({ o: 'someone-else', p: { userId: 'u1' } }),
    );
    assert.equal(MAIL_EVENT_TOPIC.decode({ kind: 'nope', userId: 'u', accountId: 'a' }), null);
    await tick();
    assert.equal(notifications.length, 1);
  }
  console.log('  ok  bus: all stays in-process; worker events reach the api process intact');

  {
    // Redis not ready: dropped at once, nothing parked in the offline queue.
    let calls = 0;
    const down = {
      client: {
        options: { db: 0 },
        status: 'reconnecting',
        publish: async () => {
          calls++;
          return 1;
        },
      },
    } as unknown as RedisService;
    new RealtimeEventsService(new CrossProcessBus(down, 'worker')).publishNotification(sampleNotification());
    await tick();
    assert.equal(calls, 0, 'no publish while Redis is not ready');
  }
  console.log('  ok  bus: publishes are dropped while Redis is not ready');

  {
    // Socket broadcasts from the worker (e.g. the timesheet-warning DMs).
    const wire: Published[] = [];
    const workerBus = new CrossProcessBus(fakeRedis(0, wire), 'worker');
    const chat = { listRoomParticipantUserIds: async () => ['u2'] };
    const workerGateway = new ChatGateway(
      {} as never,
      chat as never,
      new RealtimeEventsService(workerBus),
      workerBus,
    );
    // The worker never initializes gateways, so there is no server.
    await workerGateway.broadcastNewMessage({
      roomId: 'r1',
      senderUserId: 'u1',
      message: { id: 'm1', createdAt: new Date('2026-01-02T03:04:05.000Z') } as never,
      clientNonce: null,
    });
    assert.equal(wire.length, 2, 'msg_received + room_bumped published');

    const apiBus = new CrossProcessBus(fakeRedis(0, []), 'api');
    const apiGateway = new ChatGateway(
      {} as never,
      chat as never,
      new RealtimeEventsService(apiBus),
      apiBus,
    );
    const emitted: Array<{ rooms: string | string[]; event: string; payload: unknown }> = [];
    const server = {
      to: (rooms: string | string[]) => ({
        emit: (event: string, payload: unknown) => {
          emitted.push({ rooms, event, payload });
          return true;
        },
      }),
    };
    (apiGateway as unknown as { server: unknown }).server = server;
    apiGateway.afterInit();
    for (const w of wire) apiBus.dispatch(w.channel, w.message);
    await tick();
    assert.deepEqual(
      emitted.map((e) => [e.rooms, e.event]),
      [
        [['room:r1'], 'msg_received'],
        [['user:u2', 'user:u1'], 'room_bumped'],
      ],
    );
    assert.deepEqual(emitted[0]!.payload, {
      id: 'm1',
      createdAt: '2026-01-02T03:04:05.000Z',
      clientNonce: null,
    });
    apiGateway.onModuleDestroy();

    // With a server (api / all) the gateway emits directly, nothing on Redis.
    const allWire: Published[] = [];
    const allBus = new CrossProcessBus(fakeRedis(0, allWire), 'all');
    const allGateway = new ChatGateway({} as never, chat as never, new RealtimeEventsService(allBus), allBus);
    const direct: string[] = [];
    (allGateway as unknown as { server: unknown }).server = {
      to: () => ({ emit: (event: string) => void direct.push(event) }),
    };
    await allGateway.broadcastMessageUpdated({ roomId: 'r1', message: { id: 'm1' } as never });
    assert.deepEqual(direct, ['msg_updated']);
    assert.equal(allWire.length, 0);
  }
  console.log('  ok  socket broadcasts made in the worker are emitted by the api process');

  // ---- 5. Presence guard + worker health server -------------------------------
  const now = 1_000_000;
  const entries = [
    { member: presenceMember('all', 'h', 1), score: now - 1_000 },
    { member: presenceMember('all', 'h', 2), score: now - PRESENCE_STALE_MS - 1 },
    { member: presenceMember('worker', 'h', 3), score: now },
    { member: presenceMember('api', 'h', 4), score: now },
  ];
  assert.deepEqual(liveMembersWithRole(entries, 'all', now), ['all:h:1'], 'stale all ignored');
  assert.deepEqual(liveMembersWithRole(entries, 'worker', now), ['worker:h:3']);
  assert.deepEqual(liveMembersWithRole(entries, 'all', now + PRESENCE_STALE_MS), []);
  console.log('  ok  presence: a live ROLE=all process is detected, stale entries are not');

  {
    // The pre-boot guard on a fake ioredis client.
    const fakeReader = (score: () => number) => {
      const state = { disconnected: false, reads: 0 };
      const client: PresenceReader = {
        connect: async () => undefined,
        zrange: async (key) => {
          assert.equal(key, PRESENCE_KEY);
          state.reads++;
          return [presenceMember('all', 'h', 1), String(score())];
        },
        disconnect: () => {
          state.disconnected = true;
        },
        on: () => client,
      };
      return { client, state };
    };
    const live = fakeReader(() => Date.now());
    const started = Date.now();
    const blocked = await waitForNoLiveAllProcess('redis://fake', {
      maxWaitMs: 60,
      pollMs: 10,
      log: () => undefined,
      createClient: () => live.client,
    });
    assert.equal(blocked.ok, false, 'a live ROLE=all until the deadline blocks the worker');
    assert.match((blocked as { reason: string }).reason, /ROLE=all API process is still running/);
    assert.ok(Date.now() - started >= 60, 'waited until the deadline');
    assert.ok(live.state.reads > 1, 'polled while waiting');
    assert.ok(live.state.disconnected, 'guard connection closed');

    const stale = fakeReader(() => Date.now() - PRESENCE_STALE_MS - 1);
    const free = await waitForNoLiveAllProcess('redis://fake', {
      maxWaitMs: 60_000,
      pollMs: 10,
      log: () => undefined,
      createClient: () => stale.client,
    });
    assert.deepEqual(free, { ok: true }, 'a stale ROLE=all entry does not block');
    assert.equal(stale.state.reads, 1);
    assert.ok(stale.state.disconnected);
  }
  console.log('  ok  presence guard: waits out a live ROLE=all, ignores a stale one');

  {
    // Heartbeat reactions while running (fake ioredis, beats driven by hand).
    const presenceWith = (role: ProcessRole, members: () => string[]) => {
      const client = {
        status: 'ready',
        multi: () => {
          const chain = {
            zadd: () => chain,
            zremrangebyscore: () => chain,
            exec: async () => [],
          };
          return chain;
        },
        zrange: async () => members().flatMap((m) => [m, String(Date.now())]),
      };
      const svc = new ProcessPresenceService({ client } as unknown as RedisService, role);
      const errors: string[] = [];
      (svc as unknown as { logger: { error: (m: string) => void } }).logger.error = (m) =>
        void errors.push(m);
      const beat = (): Promise<void> => (svc as unknown as { beat(): Promise<void> }).beat();
      return { beat, errors };
    };

    const realKill = process.kill;
    const kills: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return true;
    }) as typeof process.kill;
    try {
      let others: string[] = [presenceMember('api', 'h', 9)];
      const worker = presenceWith('worker', () => others);
      await worker.beat();
      assert.equal(kills.length, 0, 'worker keeps running next to an api');
      others = [presenceMember('all', 'h', 8)];
      await worker.beat();
      await worker.beat();
      assert.deepEqual(kills, [[process.pid, 'SIGTERM']], 'worker stops once when a ROLE=all appears');
      assert.equal(worker.errors.length, 1);
    } finally {
      process.kill = realKill;
    }

    let workers: string[] = [];
    const api = presenceWith('api', () => workers);
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      for (let i = 0; i < 3; i++) await api.beat();
      assert.equal(api.errors.length, 0, 'api gives the worker 3 beats to register');
      await api.beat();
      assert.equal(api.errors.length, 0, 'a short gap (worker reload) stays quiet');
      clock += 61_000;
      await api.beat();
      await api.beat();
      assert.equal(api.errors.length, 1, 'no worker for a minute: one error, throttled');
    } finally {
      Date.now = realNow;
    }
    assert.match(api.errors[0]!, /no live ROLE=worker/);
    workers = [presenceMember('worker', 'h', 7)];
    const apiOk = presenceWith('api', () => workers);
    for (let i = 0; i < 5; i++) await apiOk.beat();
    assert.equal(apiOk.errors.length, 0, 'api with a live worker stays quiet');

    const all = presenceWith('all', () => []);
    for (let i = 0; i < 5; i++) await all.beat();
    assert.equal(all.errors.length, 0, 'ROLE=all alone logs nothing');
  }
  console.log('  ok  presence: a running worker stops next to ROLE=all; api warns without a worker');

  assert.equal(parseWorkerHealthPort(undefined), 4100);
  assert.equal(parseWorkerHealthPort('4101'), 4101);
  assert.throws(() => parseWorkerHealthPort('abc'));
  assert.throws(() => parseWorkerHealthPort('70000'));
  let redisUp = true;
  const server = await startWorkerHealthServer({
    port: 0,
    readiness: () => ({
      prisma: { raw: { $queryRaw: async () => [{ ok: 1 }] } } as never,
      redis: {
        client: { ping: async () => (redisUp ? 'PONG' : Promise.reject(new Error('down'))) },
      } as never,
    }),
  });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const alive = await fetch(`${base}/health`);
    assert.equal(alive.status, 200);
    assert.equal(((await alive.json()) as { role: string }).role, 'worker');
    const ready = await fetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(((await ready.json()) as { checks: unknown }).checks, {
      postgres: true,
      redis: true,
    });
    redisUp = false;
    assert.equal((await fetch(`${base}/health/ready`)).status, 503);
    assert.equal((await fetch(`${base}/api/v1/tasks`)).status, 404, 'no API routes on the worker');
  } finally {
    await new Promise((r) => server.close(r));
  }
  console.log('  ok  worker health server: /health, /health/ready (503 when a dependency is down)');

  {
    // Bound before the Nest context exists: ready is 503 until it does.
    let deps: { prisma: never; redis: never } | null = null;
    const booting = await startWorkerHealthServer({ port: 0, readiness: () => deps });
    try {
      const base = `http://127.0.0.1:${(booting.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/health`)).status, 200, 'alive while booting');
      const early = await fetch(`${base}/health/ready`);
      assert.equal(early.status, 503, 'not ready before the context exists');
      assert.equal(((await early.json()) as { status: string }).status, 'degraded');
      deps = {
        prisma: { raw: { $queryRaw: async () => [{ ok: 1 }] } } as never,
        redis: { client: { ping: async () => 'PONG' } } as never,
      };
      assert.equal((await fetch(`${base}/health/ready`)).status, 200, 'ready once the context exists');
    } finally {
      await new Promise((r) => booting.close(r));
    }
  }
  console.log('  ok  worker health server: 503 degraded until the context is up');

  // ---- 6. Real module options per ROLE, in child processes ---------------------
  const reports = await Promise.all(
    (['api', 'all', undefined] as const).map((role) => childReport(role)),
  );
  assert.deepEqual(
    reports.map((r) => r.role),
    ['api', 'all', 'all'],
    'ROLE unset resolves to all',
  );
  for (const report of reports) {
    const background = report.role !== 'api';
    assert.deepEqual(
      report.bullExtras,
      { manualRegistration: !background },
      `${report.role}: QueueModule BullMQ extraOptions`,
    );
    assert.deepEqual(
      report.schedule,
      { cronJobs: background, intervals: background, timeouts: background },
      `${report.role}: AppModule ScheduleModule options`,
    );
  }
  console.log('  ok  real QueueModule + AppModule options: api has no workers/crons; all and unset have both');

  console.log('\nprocess role checks passed');
}

interface ChildReport {
  role: ProcessRole;
  bullExtras: unknown;
  schedule: unknown;
}

const CHILD_FLAG = 'CHECK_PROCESS_ROLE_CHILD';
const REPORT_PREFIX = 'PROCESS_ROLE_REPORT ';

/** Run this script as a child with `ROLE=role` (undefined = unset). */
async function childReport(role: ProcessRole | undefined): Promise<ChildReport> {
  const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_FLAG]: '1' };
  if (role === undefined) delete env.ROLE;
  else env.ROLE = role;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', __filename],
    { cwd: resolve(__dirname, '../..'), env, timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(REPORT_PREFIX));
  assert.ok(line, `child ROLE=${role ?? '(unset)'} printed no report:\n${stdout}`);
  return JSON.parse(line.slice(REPORT_PREFIX.length)) as ChildReport;
}

/** Child side: load the real modules under this process's ROLE. */
async function reportModuleOptions(): Promise<void> {
  const { QueueModule } = await import('../queue/queue.module');
  const { APP_SCHEDULE_OPTIONS } = await import('../app.module');
  const imports = (Reflect.getMetadata('imports', QueueModule) ?? []) as Array<{
    providers?: Array<{ provide?: unknown; useValue?: unknown }>;
  }>;
  const extras = imports
    .flatMap((m) => m.providers ?? [])
    .find((p) => p.provide === BULL_EXTRA_OPTIONS_TOKEN);
  assert.ok(extras, 'QueueModule registers BullMQ extra options');
  const report: ChildReport = {
    role: getProcessRole(),
    bullExtras: extras.useValue,
    schedule: APP_SCHEDULE_OPTIONS,
  };
  process.stdout.write(`\n${REPORT_PREFIX}${JSON.stringify(report)}\n`);
}

function sampleNotification(): RealtimeNotificationEvent {
  return {
    userId: 'u1',
    notification: {
      id: 'n1',
      type: 'TASK_ASSIGNED',
      title: 'Task assigned',
      body: 'Ship it',
      url: '/tasks/1',
      entityType: 'TASK',
      entityId: 't1',
      createdAt: new Date('2026-10-27T10:00:00.000Z'),
    },
  };
}

(process.env[CHILD_FLAG] === '1' ? reportModuleOptions() : main()).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
