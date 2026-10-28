/**
 * Server gaps closed for task A4 (finish the half-built screens), no database
 * and no Redis: each service runs against a small in-memory fake.
 *
 *  - G5 milestone reorder takes exactly the contract's full milestone set
 *    (a subset, a duplicate or a stranger is a 400 and writes nothing);
 *  - G6 an expense recorded by a payroll run is flagged `fromPayroll`;
 *  - G7 setting or clearing a task's custom-field value takes `update` on that
 *    task row (403 otherwise), a value on a task the caller cannot see clears
 *    as a 404, and a task field pinned to a project only lands on its tasks;
 *  - G8 a sprint cannot end before it starts, on create, on a full edit and on
 *    a partial edit checked against the stored other date; `goal` clears;
 *  - G9 a folder resync is capped at one per user per folder per window (429),
 *    and refused (503) when Redis cannot check the cap or never answers;
 *  - G10 moving a payment's received currency or an expense's currency to
 *    another non-base currency without a rate is a 400 fx_rate_required (as
 *    is creating a non-base expense without one), and writes nothing;
 *  - G11 contracts follow the same rule: a non-base contract needs its rate
 *    (create, or a currency change), and the base currency books at 1;
 *  - G12 an incoming FX rate is a positive number: '' / '0' / '-1' are a 400
 *    at the schema, and the services still read a blank as "no rate" and
 *    refuse a non-positive contract rate.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { defineAbilityFor, presetPermissions } from '@botss/auth';
import {
  createContractSchema,
  createExpenseSchema,
  createPaymentSchema,
  createSprintSchema,
  expenseWithRefsSchema,
  isRateText,
  rateInput,
  recordPaymentSchema,
  updateContractSchema,
  updateExpenseSchema,
  updatePaymentSchema,
  listCustomFieldValuesQuerySchema,
  updateSprintSchema,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { ContractsService } from '../finance/contracts.service';
import { ExpensesService } from '../finance/expenses.service';
import { bookRate } from '../finance/serialize';
import { MilestonesService } from '../finance/milestones.service';
import { PaymentsService } from '../finance/payments.service';
import { MailReadService } from '../mail/mail-read.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { SprintsService } from '../sprints/sprints.service';

type Row = Record<string, unknown>;

const WS = 'cmws0000000000000000000ws';
const USER = 'cmuser000000000000000user';
const OTHER_USER = 'cmother00000000000000othr';
const PROJECT_A = 'cmproja000000000000000pja';
const PROJECT_B = 'cmprojb000000000000000pjb';
const CONTRACT = 'cmcontract000000000000ctr';
const M1 = 'cmmile1000000000000000ms1';
const M2 = 'cmmile2000000000000000ms2';
const M3 = 'cmmile3000000000000000ms3';
const STRANGER = 'cmstranger00000000000strg';

const scope: UserScope = {
  userId: USER,
  workspaceIds: [WS],
  projectIds: [PROJECT_A],
  currentWorkspaceId: WS,
  workspaceRole: 'VIEWER',
  seesEveryProject: false,
} as unknown as UserScope;

const noRedis = {
  client: { multi: () => ({ incr: () => null, expire: () => null, exec: async () => [] }) },
} as unknown as RedisService;

const isStatus = (status: number) => (e: unknown) =>
  e instanceof HttpException && e.getStatus() === status;

async function main() {
  // --- G5 milestone reorder ----------------------------------------------------
  {
    const writes: Row[] = [];
    const prisma = {
      client: {
        contract: { findFirst: async () => ({ id: CONTRACT, workspaceId: WS, projectId: null }) },
        contractMilestone: {
          findMany: async (args: { where: Row }) => {
            assert.deepEqual(args.where, { contractId: CONTRACT }, 'reorder reads the full set');
            return [{ id: M1 }, { id: M2 }, { id: M3 }];
          },
        },
        $transaction: async (fn: (tx: unknown) => Promise<void>) =>
          fn({ contractMilestone: { update: async (a: Row) => writes.push(a) } }),
      },
    } as unknown as PrismaService;
    const milestones = new MilestonesService(prisma, noRedis);

    for (const [label, ids] of [
      ['subset', [M2, M1]],
      ['duplicate', [M1, M1, M2]],
      ['stranger', [M1, M2, STRANGER]],
      ['superset', [M1, M2, M3, STRANGER]],
    ] as const) {
      await assert.rejects(
        milestones.reorder(scope, CONTRACT, { ids: [...ids] }),
        (e: unknown) => e instanceof BadRequestException,
        `G5: ${label} reorder is a 400`,
      );
    }
    assert.equal(writes.length, 0, 'G5: refused reorders write nothing');

    await milestones.reorder(scope, CONTRACT, { ids: [M3, M1, M2] });
    const finalPositions = writes
      .slice(3)
      .map((w) => [(w['where'] as Row)['id'], (w['data'] as Row)['position']]);
    assert.deepEqual(
      finalPositions,
      [
        [M3, 0],
        [M1, 1],
        [M2, 2],
      ],
      'G5: full-set reorder lands 0..n-1',
    );
    console.log('  ok  G5 milestone reorder requires the full set');
  }

  // --- G6 payroll expenses -----------------------------------------------------
  {
    const base = {
      workspaceId: WS,
      projectId: null,
      contractId: null,
      category: 'SALARY',
      vendor: null,
      description: 'Salary',
      amount: '100.00',
      currency: 'PKR',
      fxRate: '1',
      baseAmount: '100.00',
      paymentSourceId: null,
      incurredAt: new Date(),
      reference: null,
      receiptFileId: null,
      recordedById: USER,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      project: null,
      contract: null,
      paymentSource: null,
      receipt: null,
      recordedBy: null,
    };
    let include: Row = {};
    const prisma = {
      client: {
        expense: {
          findMany: async (args: { include: Row }) => {
            include = args.include;
            return [
              {
                ...base,
                id: 'cmexppayroll0000000000001',
                payrollItem: { id: 'cmpayitem00000000000001' },
              },
              { ...base, id: 'cmexpmanual00000000000002', payrollItem: null },
            ];
          },
          count: async () => 2,
        },
      },
    } as unknown as PrismaService;
    const expenses = new ExpensesService(prisma, noRedis);
    const list = await expenses.list(scope, {
      page: 1,
      pageSize: 50,
      sort: 'incurredAt',
      order: 'desc',
    } as never);
    assert.ok(include['payrollItem'], 'G6: list includes the payroll back-relation');
    assert.deepEqual(
      list.items.map((e) => e.fromPayroll),
      [true, false],
      'G6: fromPayroll mirrors the payroll item',
    );
    for (const item of list.items) expenseWithRefsSchema.parse(item);
    console.log('  ok  G6 payroll expenses are flagged');
  }

  // --- G7 custom-field values ----------------------------------------------------
  {
    const DEF_A = 'cmdefa0000000000000000dfa';
    const VALUE_A = 'cmvala0000000000000000vla';
    const VALUE_B = 'cmvalb0000000000000000vlb';
    const TASK_A = 'cmtaska000000000000000tka';
    const TASK_B = 'cmtaskb000000000000000tkb';
    const tasks: Row[] = [
      {
        id: TASK_A,
        projectId: PROJECT_A,
        status: 'TODO',
        createdById: OTHER_USER,
        assigneeId: null,
      },
      // A task the caller cannot see (another project, no membership).
      {
        id: TASK_B,
        projectId: PROJECT_B,
        status: 'TODO',
        createdById: OTHER_USER,
        assigneeId: null,
      },
    ];
    const visibleProjects = new Set([PROJECT_A]);
    const values: Row[] = [
      {
        id: VALUE_A,
        definitionId: DEF_A,
        entityId: TASK_A,
        definition: { scope: 'TASK', projectId: PROJECT_A },
      },
      {
        id: VALUE_B,
        definitionId: DEF_A,
        entityId: TASK_B,
        definition: { scope: 'TASK', projectId: null },
      },
    ];
    const writes: string[] = [];
    const prisma = {
      client: {
        customFieldDefinition: {
          findFirst: async () => ({
            id: DEF_A,
            workspaceId: WS,
            scope: 'TASK',
            projectId: PROJECT_A,
            type: 'TEXT',
            options: null,
          }),
        },
        task: {
          findFirst: async (args: { where: Row }) => {
            assert.equal(
              (args.where['project'] as Row)['workspaceId'],
              WS,
              'G7: task lookup pinned to the workspace',
            );
            const t = tasks.find((x) => x.id === args.where['id']);
            return t && visibleProjects.has(t['projectId'] as string) ? t : null;
          },
        },
        customFieldValue: {
          findFirst: async (args: { where: Row }) =>
            values.find((v) => v.id === args.where['id']) ?? null,
          upsert: async (args: { create: Row }) => {
            writes.push('upsert');
            return {
              id: VALUE_A,
              ...args.create,
              value: 'x',
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
          delete: async () => {
            writes.push('delete');
            return {};
          },
        },
      },
    } as unknown as PrismaService;
    const fields = new CustomFieldsService(prisma);
    const permissions = presetPermissions({
      systemRole: 'EMPLOYEE',
      workspaceMemberships: [{ role: 'VIEWER' }],
    });
    const viewer = defineAbilityFor({
      userId: USER,
      systemRole: 'EMPLOYEE',
      permissions,
      workspaceMemberships: [{ workspaceId: WS, role: 'VIEWER' }],
      projectMemberships: [
        { projectId: PROJECT_A, workspaceId: WS, role: 'VIEWER', abilities: null },
      ],
    });
    const contributor = defineAbilityFor({
      userId: USER,
      systemRole: 'EMPLOYEE',
      permissions,
      workspaceMemberships: [{ workspaceId: WS, role: 'VIEWER' }],
      projectMemberships: [
        { projectId: PROJECT_A, workspaceId: WS, role: 'CONTRIBUTOR', abilities: null },
      ],
    });
    assert.ok(!viewer.can('update', 'Task'), 'G7: fixture viewer has no task update');

    await assert.rejects(
      fields.setValue(scope, viewer, { definitionId: DEF_A, entityId: TASK_A, value: 'x' }),
      (e: unknown) => e instanceof ForbiddenException,
      'G7: set without task update is a 403',
    );
    await assert.rejects(
      fields.clearValue(scope, viewer, VALUE_A),
      (e: unknown) => e instanceof ForbiddenException,
      'G7: clear without task update is a 403',
    );
    await assert.rejects(
      fields.clearValue(scope, contributor, VALUE_B),
      (e: unknown) => e instanceof NotFoundException,
      "G7: clear on a task the caller can't see is a 404",
    );
    await assert.rejects(
      fields.setValue(scope, contributor, { definitionId: DEF_A, entityId: TASK_B, value: 'x' }),
      isStatus(400),
      "G7: set on a task the caller can't see is refused",
    );
    visibleProjects.add(PROJECT_B);
    await assert.rejects(
      fields.setValue(scope, contributor, { definitionId: DEF_A, entityId: TASK_B, value: 'x' }),
      isStatus(400),
      "G7: a field pinned to project A doesn't land on project B's task",
    );
    visibleProjects.delete(PROJECT_B);
    assert.deepEqual(writes, [], 'G7: refused value writes touch nothing');

    await fields.setValue(scope, contributor, {
      definitionId: DEF_A,
      entityId: TASK_A,
      value: 'x',
    });
    await fields.clearValue(scope, contributor, VALUE_A);
    assert.deepEqual(writes, ['upsert', 'delete'], 'G7: a contributor sets and clears');

    assert.ok(listCustomFieldValuesQuerySchema.safeParse({ projectId: PROJECT_A }).success);
    assert.ok(listCustomFieldValuesQuerySchema.safeParse({ entityId: TASK_A }).success);
    assert.ok(!listCustomFieldValuesQuerySchema.safeParse({}).success, 'G7: list needs a filter');
    assert.ok(
      !listCustomFieldValuesQuerySchema.safeParse({ entityId: TASK_A, projectId: PROJECT_A })
        .success,
      'G7: list takes one filter',
    );
    console.log('  ok  G7 custom-field value writes take task update');
  }

  // --- G8 sprint dates -------------------------------------------------------------
  {
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
    assert.ok(
      !createSprintSchema.safeParse({
        name: 'S',
        startDate: day('2026-10-10'),
        endDate: day('2026-10-09'),
      }).success,
      'G8: create end < start is refused',
    );
    assert.ok(
      createSprintSchema.safeParse({
        name: 'S',
        startDate: day('2026-10-10'),
        endDate: day('2026-10-10'),
      }).success,
      'G8: a one-day sprint is fine',
    );
    assert.ok(
      !updateSprintSchema.safeParse({ startDate: day('2026-10-10'), endDate: day('2026-10-01') })
        .success,
      'G8: edit end < start is refused',
    );
    assert.ok(updateSprintSchema.safeParse({ goal: null }).success, 'G8: goal clears');

    const SPRINT = 'cmsprint0000000000000spr';
    const updates: Row[] = [];
    const prisma = {
      client: {
        sprint: {
          findUnique: async () => ({
            id: SPRINT,
            projectId: PROJECT_A,
            startDate: day('2026-10-10'),
            endDate: day('2026-10-20'),
            status: 'PLANNED',
            project: { id: PROJECT_A, workspaceId: WS },
          }),
          update: async (args: Row) => {
            updates.push(args);
            return {};
          },
        },
        project: { findFirst: async () => ({ id: PROJECT_A }) },
      },
    } as unknown as PrismaService;
    const sprints = new SprintsService(prisma, {} as never);
    await assert.rejects(
      sprints.update(scope, SPRINT, { endDate: day('2026-10-05') }),
      (e: unknown) => e instanceof BadRequestException,
      'G8: a partial edit ending before the stored start is a 400',
    );
    await assert.rejects(
      sprints.update(scope, SPRINT, { startDate: day('2026-10-25') }),
      (e: unknown) => e instanceof BadRequestException,
      'G8: a partial edit starting after the stored end is a 400',
    );
    assert.equal(updates.length, 0, 'G8: refused edits write nothing');
    await sprints.update(scope, SPRINT, { endDate: day('2026-10-10'), goal: null });
    assert.deepEqual(
      (updates[0] as Row)['data'],
      { endDate: day('2026-10-10'), goal: null },
      'G8: valid edit writes',
    );
    console.log('  ok  G8 sprint dates stay in order');
  }

  // --- G9 folder resync rate limit -------------------------------------------------
  {
    const FOLDER = 'cmfolder000000000000fldr1';
    const FOLDER_2 = 'cmfolder000000000000fldr2';
    const slots = new Map<string, number>();
    const redis = {
      client: {
        set: async (key: string, _v: string, ex: string, seconds: number, nx: string) => {
          assert.equal(ex, 'EX');
          assert.equal(nx, 'NX');
          assert.equal(seconds, MailReadService.RESYNC_WINDOW_SECONDS);
          if (slots.has(key)) return null;
          slots.set(key, seconds);
          return 'OK';
        },
      },
    } as unknown as RedisService;
    let syncs = 0;
    const prisma = {
      client: {
        mailFolder: {
          findUnique: async (args: { where: Row }) => ({
            id: args.where['id'],
            account: { id: 'cmacct0000000000000acct', userId: USER },
          }),
          update: async () => ({}),
        },
      },
    } as unknown as PrismaService;
    // The resync runs as a BullMQ job now; a queued job stands in for a sync.
    const sync = {};
    const queue = {
      add: async (_name: string, data: Row, opts: Row) => {
        syncs += 1;
        assert.equal(data['kind'], 'resync-folder');
        assert.equal(opts['jobId'], `resync-folder-${String(data['folderId'])}`);
        return { id: opts['jobId'] };
      },
    };
    const mail = new MailReadService(prisma, sync as never, {} as never, redis, queue as never);
    assert.deepEqual(await mail.resyncFolder(USER, FOLDER), {
      ok: true,
      queued: true,
      jobId: `resync-folder-${FOLDER}`,
      healed: 0,
    });
    await assert.rejects(
      mail.resyncFolder(USER, FOLDER),
      isStatus(429),
      'G9: second resync in the window is a 429',
    );
    assert.equal(syncs, 1, 'G9: the refused resync never reaches IMAP');
    await mail.resyncFolder(USER, FOLDER_2);
    assert.equal(syncs, 2, 'G9: the window is per folder');
    await assert.rejects(
      mail.resyncFolder(OTHER_USER, FOLDER),
      isStatus(403),
      "G9: someone else's folder is a 403",
    );

    // Redis down: refused as a 503, never an uncapped sync.
    const downRedis = {
      client: { set: async () => Promise.reject(new Error('ECONNREFUSED')) },
    } as unknown as RedisService;
    const mailNoRedis = new MailReadService(
      prisma,
      sync as never,
      {} as never,
      downRedis,
      queue as never,
    );
    await assert.rejects(
      mailNoRedis.resyncFolder(USER, 'cmfolder000000000000fldr3'),
      (e: unknown) =>
        isStatus(503)(e) &&
        (e as HttpException).getResponse() instanceof Object &&
        ((e as HttpException).getResponse() as { code?: string }).code ===
          'mail_resync_unavailable',
      'G9: Redis down is a 503',
    );
    assert.equal(syncs, 2, 'G9: no sync runs without the rate limit');

    // Redis offline: ioredis queues the command forever. The claim times out
    // into the same 503 instead of hanging the request.
    const hungRedis = {
      client: { set: () => new Promise<never>(() => undefined) },
    } as unknown as RedisService;
    const mailHung = new MailReadService(
      prisma,
      sync as never,
      {} as never,
      hungRedis,
      queue as never,
    );
    const started = Date.now();
    await assert.rejects(
      mailHung.resyncFolder(USER, 'cmfolder000000000000fldr4'),
      isStatus(503),
      'G9: a Redis that never answers is a 503',
    );
    assert.ok(
      Date.now() - started < MailReadService.RESYNC_REDIS_TIMEOUT_MS + 1_000,
      'G9: bounded wait',
    );
    assert.equal(syncs, 2, 'G9: no sync runs while Redis hangs');

    // Redis slow: the claim lands after the timeout. It is released so the
    // person's retry is not refused by a resync that never ran.
    const deleted: string[] = [];
    const slowRedis = {
      client: {
        set: () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('OK'), MailReadService.RESYNC_REDIS_TIMEOUT_MS + 300),
          ),
        del: async (key: string) => {
          deleted.push(key);
          return 1;
        },
      },
    } as unknown as RedisService;
    const mailSlow = new MailReadService(
      prisma,
      sync as never,
      {} as never,
      slowRedis,
      queue as never,
    );
    await assert.rejects(
      mailSlow.resyncFolder(USER, 'cmfolder000000000000fldr5'),
      isStatus(503),
      'G9: a slow Redis times out as a 503',
    );
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(
      deleted,
      [`mail:resync:${USER}:cmfolder000000000000fldr5`],
      'G9: late claim released',
    );
    assert.equal(syncs, 2, 'G9: no sync runs on a late claim');

    // Enqueue fails after the claim: the slot is released (DEL of the same
    // key), so the retry is not a false 429.
    const claimed = new Map<string, string>();
    const released: string[] = [];
    const fakeIoredis = {
      client: {
        set: async (key: string, value: string, _ex: string, _secs: number, nx: string) => {
          assert.equal(nx, 'NX');
          if (claimed.has(key)) return null;
          claimed.set(key, value);
          return 'OK';
        },
        del: async (key: string) => {
          released.push(key);
          return claimed.delete(key) ? 1 : 0;
        },
      },
    } as unknown as RedisService;
    let queueUp = false;
    const flakyQueue = {
      add: async (_name: string, _data: Row, opts: Row) => {
        if (!queueUp) throw new Error('Connection is closed.');
        return { id: opts['jobId'] };
      },
    };
    const mailFlaky = new MailReadService(
      prisma,
      sync as never,
      {} as never,
      fakeIoredis,
      flakyQueue as never,
    );
    const FOLDER_6 = 'cmfolder000000000000fldr6';
    await assert.rejects(
      mailFlaky.resyncFolder(USER, FOLDER_6),
      isStatus(503),
      'G9: enqueue failure is a 503',
    );
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      released,
      [`mail:resync:${USER}:${FOLDER_6}`],
      'G9: failed enqueue releases its slot',
    );
    assert.equal(claimed.size, 0);
    queueUp = true;
    assert.equal(
      (await mailFlaky.resyncFolder(USER, FOLDER_6)).queued,
      true,
      'G9: retry after a failed enqueue',
    );
    console.log('  ok  G9 folder resync is rate limited');
  }

  // --- G10 rate required off the base currency -------------------------------------
  {
    const codeIs = (code: string) => (e: unknown) =>
      e instanceof BadRequestException && (e.getResponse() as { code?: string }).code === code;
    const writes: string[] = [];
    const payment = {
      id: 'cmpaymentfx00000000000pay',
      workspaceId: WS,
      contractId: CONTRACT,
      invoiceId: null,
      milestoneId: null,
      currency: 'PKR',
      amount: '100.00',
      receivedAmount: '100.00',
      receivedCurrency: 'PKR',
      feeAmount: '0.00',
      fxRate: '1',
      voidedAt: null,
    };
    const expense = {
      id: 'cmexpensefx00000000000exp',
      workspaceId: WS,
      currency: 'PKR',
      amount: '50.00',
      fxRate: '1',
    };
    const prisma = {
      client: {
        workspace: { findUnique: async () => ({ organization: { baseCurrency: 'PKR' } }) },
        payment: { findFirst: async () => payment },
        expense: {
          findFirst: async () => expense,
          create: async () => writes.push('expense.create'),
          update: async () => writes.push('expense.update'),
        },
        payrollItem: { findUnique: async () => null },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            payment: { update: async () => writes.push('payment.update') },
            contractMilestone: { findUnique: async () => null },
          }),
      },
    } as unknown as PrismaService;
    const payments = new PaymentsService(prisma, {} as never, noRedis);
    const expenses = new ExpensesService(prisma, noRedis);

    await assert.rejects(
      payments.update(scope, payment.id, { receivedCurrency: 'USD' }),
      codeIs('fx_rate_required'),
      'G10: payment received currency off base without a rate',
    );
    await assert.rejects(
      expenses.update(scope, expense.id, { currency: 'USD' }),
      codeIs('fx_rate_required'),
      'G10: expense currency off base without a rate',
    );
    await assert.rejects(
      expenses.create(scope, { description: 'x', amount: '5', currency: 'USD' }),
      codeIs('fx_rate_required'),
      'G10: new non-base expense without a rate',
    );
    // A blank rate reads as "no rate" (schema bypassed).
    await assert.rejects(
      payments.update(scope, payment.id, { receivedCurrency: 'USD', fxRate: '' } as never),
      codeIs('fx_rate_required'),
      'G12: blank rate on a non-base payment',
    );
    await assert.rejects(
      expenses.update(scope, expense.id, { currency: 'USD', fxRate: '' } as never),
      codeIs('fx_rate_required'),
      'G12: blank rate on a non-base expense',
    );
    await assert.rejects(
      expenses.create(scope, {
        description: 'x',
        amount: '5',
        currency: 'USD',
        fxRate: '',
      } as never),
      codeIs('fx_rate_required'),
      'G12: blank rate on a new non-base expense',
    );
    // Too large for Decimal(18, 8): a 400, never a database error.
    await assert.rejects(
      expenses.update(scope, expense.id, { currency: 'USD', fxRate: '99999999999' } as never),
      codeIs('invalid_fx_rate'),
      'G12: overflowing expense rate',
    );
    await assert.rejects(
      payments.update(scope, payment.id, { receivedCurrency: 'USD', fxRate: 1e12 } as never),
      codeIs('invalid_fx_rate'),
      'G12: overflowing payment rate',
    );
    assert.deepEqual(writes, [], 'G10: refused writes touch nothing');
    console.log('  ok  G10 a non-base currency change needs its rate');
  }

  // --- G11 contract booked rate -----------------------------------------------------
  {
    const codeIs = (code: string) => (e: unknown) =>
      e instanceof BadRequestException && (e.getResponse() as { code?: string }).code === code;
    const STOP = 'stop-after-write';
    const writes: Array<{ op: string; data: Row }> = [];
    const existing = { id: CONTRACT, workspaceId: WS, currency: 'USD', fxRateToBase: '280' };
    const prisma = {
      client: {
        workspace: { findUnique: async () => ({ organization: { baseCurrency: 'PKR' } }) },
        project: {
          findFirst: async () => ({ id: PROJECT_A }),
          findUnique: async () => ({ clientId: null }),
        },
        contract: { findFirst: async () => existing },
        payment: { count: async () => 0 },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            contract: {
              create: async (args: { data: Row }) => {
                writes.push({ op: 'create', data: args.data });
                throw new Error(STOP);
              },
              update: async (args: { data: Row }) => {
                writes.push({ op: 'update', data: args.data });
                throw new Error(STOP);
              },
            },
          }),
      },
    } as unknown as PrismaService;
    const contracts = new ContractsService(prisma, noRedis);
    const stopped = (e: unknown) => e instanceof Error && e.message === STOP;
    const rateOf = (i: number) => String((writes[i]?.data as Row)['fxRateToBase']);

    await assert.rejects(
      contracts.create(scope, { title: 'x', projectId: PROJECT_A, currency: 'USD' } as never),
      codeIs('fx_rate_required'),
      'G11: a new non-base contract needs its rate',
    );
    assert.equal(writes.length, 0, 'G11: refused create writes nothing');

    await assert.rejects(
      contracts.create(scope, {
        title: 'x',
        projectId: PROJECT_A,
        currency: 'PKR',
        fxRateToBase: '280',
      } as never),
      stopped,
    );
    assert.equal(rateOf(0), '1', 'G11: a base-currency contract books at 1');

    await assert.rejects(
      contracts.update(scope, CONTRACT, { currency: 'EUR' }),
      codeIs('fx_rate_required'),
      'G11: moving to another non-base currency needs its rate',
    );
    assert.equal(writes.length, 1, 'G11: refused update writes nothing');

    await assert.rejects(
      contracts.update(scope, CONTRACT, { currency: 'PKR', fxRateToBase: '280' }),
      stopped,
    );
    assert.equal(rateOf(1), '1', 'G11: moving to the base currency books at 1');

    await assert.rejects(contracts.update(scope, CONTRACT, { title: 'renamed' }), stopped);
    assert.equal(
      (writes[2]?.data as Row)['fxRateToBase'],
      undefined,
      'G11: an edit without a rate keeps the stored one',
    );
    console.log('  ok  G11 contracts book a real rate to base');

    // G12 (service level, schema bypassed): a blank rate is "no rate", and a
    // zero rate is refused rather than booked.
    await assert.rejects(
      contracts.create(scope, {
        title: 'x',
        projectId: PROJECT_A,
        currency: 'USD',
        fxRateToBase: '',
      } as never),
      codeIs('fx_rate_required'),
      'G12: blank contract rate reads as missing',
    );
    await assert.rejects(
      contracts.create(scope, {
        title: 'x',
        projectId: PROJECT_A,
        currency: 'USD',
        fxRateToBase: '0',
      } as never),
      codeIs('invalid_fx_rate'),
      'G12: zero contract rate refused',
    );
    await assert.rejects(
      contracts.update(scope, CONTRACT, { currency: 'EUR', fxRateToBase: '' } as never),
      codeIs('fx_rate_required'),
      'G12: blank rate on a currency change reads as missing',
    );
  }

  // --- G12 rate schemas ---------------------------------------------------------------
  {
    const base = { title: 'x', projectId: PROJECT_A, currency: 'USD' };
    const cases: Array<[string, (rate: unknown) => boolean]> = [
      [
        'contract create',
        (r) => createContractSchema.safeParse({ ...base, fxRateToBase: r }).success,
      ],
      ['contract update', (r) => updateContractSchema.safeParse({ fxRateToBase: r }).success],
      [
        'payment create',
        (r) =>
          createPaymentSchema.safeParse({ contractId: CONTRACT, amount: '1', fxRate: r }).success,
      ],
      ['payment update', (r) => updatePaymentSchema.safeParse({ fxRate: r }).success],
      [
        'expense create',
        (r) => createExpenseSchema.safeParse({ description: 'x', amount: '1', fxRate: r }).success,
      ],
      ['expense update', (r) => updateExpenseSchema.safeParse({ fxRate: r }).success],
      ['invoice payment', (r) => recordPaymentSchema.safeParse({ amount: '1', fxRate: r }).success],
    ];
    for (const [name, ok] of cases) {
      for (const bad of ['', ' ', '0', '0.0', '-1', 'abc', 0, -2, Number.POSITIVE_INFINITY]) {
        assert.equal(ok(bad), false, `G12: ${name} refuses rate ${JSON.stringify(bad)}`);
      }
      for (const good of ['280', '0.0036', ' 278.5 ', 280]) {
        assert.equal(ok(good), true, `G12: ${name} accepts rate ${JSON.stringify(good)}`);
      }
      assert.equal(ok(undefined), true, `G12: ${name} rate stays optional`);
    }
    // Shared text rule (schemas + web forms): plain decimals only.
    for (const good of ['278.5', '.5', '1.', '0.0036', '9999999999.99999999']) {
      assert.equal(isRateText(good), true, `G12: "${good}" is a rate`);
    }
    for (const bad of ['1e-3', '1E5', '', '.', '0', '-1', '10000000000', '12,5']) {
      assert.equal(isRateText(bad), false, `G12: "${bad}" is not a rate`);
    }
    assert.equal(rateInput.parse(' 278.5 '), '278.5', 'G12: rate text is trimmed');
    assert.equal(rateInput.parse('.5'), '.5', 'G12: ".5" accepted');
    assert.ok(!rateInput.safeParse('1e-3').success, 'G12: exponent refused');
    assert.ok(!rateInput.safeParse('10000000000').success, 'G12: too large refused');
    assert.ok(!rateInput.safeParse(1e12).success, 'G12: too large number refused');

    // Rounded to the stored 8dp before use; bounded to Decimal(18, 8).
    assert.equal(bookRate('278.123456789').toString(), '278.12345679', 'G12: rate rounded to 8dp');
    assert.equal(bookRate(' .5 ').toString(), '0.5', 'G12: ".5" books as 0.5');
    assert.throws(
      () => bookRate('9999999999.999999999'),
      (e: unknown) => e instanceof BadRequestException,
    );
    assert.throws(
      () => bookRate('0.000000001'),
      (e: unknown) => e instanceof BadRequestException,
      'G12: rounds to 0',
    );
    console.log('  ok  G12 FX rates must be positive numbers');
  }

  console.log('check-finish-screens: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
