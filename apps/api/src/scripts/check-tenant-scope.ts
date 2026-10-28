/**
 * Tenant-scope self-checks (no database): ids a caller supplies for another
 * record (sprint, receipt, payment source, parent goal, assignee...) must
 * resolve inside the caller's own workspace / organization, and a refused
 * request writes nothing. Each service runs against a fake Prisma that
 * answers a scoped lookup only when the recorded `where` pins the right
 * workspace / organization, so a dropped filter shows up as a failure.
 * Covered: the tenant-scope helpers, milestones, expenses, payments, chat
 * member removal, channel creation, goals, todos, timesheets, lead conversion,
 * mail replies, custom-field values, LiveKit, the workspace-role guard,
 * workspaces, mailbox self-setup and the client-portal invite.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { ChatService } from '../chat/chat.service';
import { ClientPortalService } from '../clients/client-portal.service';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard';
import { invalidReference, orgWorkspaceMembership, requireTenantRef } from '../common/tenant-scope';
import { ExpensesService } from '../finance/expenses.service';
import { MilestonesService } from '../finance/milestones.service';
import { paymentSourceForWorkspace } from '../finance/payment-source-ref';
import { PaymentsService } from '../finance/payments.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { GoalsService } from '../goals/goals.service';
import { LeadsService } from '../leads/leads.service';
import { LivekitService } from '../livekit/livekit.service';
import { MailAccountsService } from '../mail/mail-accounts.service';
import { MailSendService } from '../mail/mail-send.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { TimesheetsService } from '../timesheets/timesheets.service';
import { TodosService } from '../todos/todos.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

const ORG_A = 'cmorga000000000000000000a';
const ORG_B = 'cmorgb000000000000000000b';
const USER_A = 'cmusera00000000000000000a';
const USER_A2 = 'cmusera20000000000000000a';
const USER_B = 'cmuserb00000000000000000b';
const USER_NOORG = 'cmusernoorg000000000000000';
const WS_A = 'cmwsa0000000000000000000a';
const WS_B = 'cmwsb0000000000000000000b';
const PROJECT_A = 'cmprojecta00000000000000a';
const PROJECT_A2 = 'cmprojecta20000000000000a';
const PROJECT_B = 'cmprojectb00000000000000b';
const DEFINITION = 'cmdefinition0000000000000';
const LEAD = 'cmlead00000000000000000000';
const MAIL_MSG_B = 'cmmailmsgb0000000000000000';
const ROOM = 'cmroom00000000000000000000';
const CONTRACT = 'cmcontract0000000000000000';
const MILESTONE = 'cmmilestone00000000000000';
const SPRINT_A = 'cmsprinta00000000000000a';
const SPRINT_A2 = 'cmsprinta20000000000000a';
const SPRINT_B = 'cmsprintb00000000000000b';
const TASK_A = 'cmtaska000000000000000000a';
const TASK_B = 'cmtaskb000000000000000000b';
const SOURCE_A = 'cmsourcea00000000000000a';
const SOURCE_B = 'cmsourceb00000000000000b';
const FILE_A = 'cmfilea000000000000000000a';
const FILE_B = 'cmfileb000000000000000000b';
const GOAL_A = 'cmgoala000000000000000000a';
const GOAL_A2 = 'cmgoala2000000000000000a';
const GOAL_B = 'cmgoalb000000000000000000b';
const PAYMENT = 'cmpayment0000000000000000';
const EXPENSE = 'cmexpense0000000000000000';
const CLIENT_ID = 'cmclient00000000000000000';

type Where = Record<string, unknown>;

/** user -> organization; `null` is an org-less user. */
const USER_ORG: Record<string, string | null> = {
  [USER_A]: ORG_A,
  [USER_A2]: ORG_A,
  [USER_B]: ORG_B,
  [USER_NOORG]: null,
};
const WORKSPACE_ORG: Record<string, string> = { [WS_A]: ORG_A, [WS_B]: ORG_B };
const SPRINTS: Record<string, { workspaceId: string; projectId: string }> = {
  [SPRINT_A]: { workspaceId: WS_A, projectId: PROJECT_A },
  [SPRINT_A2]: { workspaceId: WS_A, projectId: PROJECT_A2 },
  [SPRINT_B]: { workspaceId: WS_B, projectId: PROJECT_B },
};
const TASKS: Record<string, { workspaceId: string; projectId: string }> = {
  [TASK_A]: { workspaceId: WS_A, projectId: PROJECT_A },
  [TASK_B]: { workspaceId: WS_B, projectId: PROJECT_B },
};
const SOURCES: Record<string, string> = { [SOURCE_A]: ORG_A, [SOURCE_B]: ORG_B };
const FILES: Record<string, string> = { [FILE_A]: WS_A, [FILE_B]: WS_B };
const PROJECTS: Record<string, string> = {
  [PROJECT_A]: WS_A,
  [PROJECT_A2]: WS_A,
  [PROJECT_B]: WS_B,
};
const GOALS: Record<string, string> = { [GOAL_A]: WS_A, [GOAL_A2]: WS_A, [GOAL_B]: WS_B };

/** Leftover memberships: USER_A still belongs to WS_B (moved between orgs). */
const MEMBERSHIPS = [
  { workspaceId: WS_A, userId: USER_A, role: 'MEMBER' },
  { workspaceId: WS_B, userId: USER_A, role: 'ADMIN' },
  { workspaceId: WS_A, userId: USER_A2, role: 'MEMBER' },
  { workspaceId: WS_B, userId: USER_A2, role: 'MEMBER' },
  { workspaceId: WS_B, userId: USER_B, role: 'MEMBER' },
  // USER_B (org B) still has a row in WS_A, an org-A workspace.
  { workspaceId: WS_A, userId: USER_B, role: 'MEMBER' },
];

interface Opts {
  /** Does the room's target user appear as a chat participant? */
  chatMember?: boolean;
  /** Raw `user.findFirst` row for the portal invite. */
  existingUser?: Record<string, unknown> | null;
}

/**
 * A scoped lookup answers only when its `where` pins the right tenant, so a
 * service that drops the filter gets null (and is refused). Every `where` is
 * recorded in `seen[model.method]`; every write lands in `writes`.
 */
function fakePrisma(opts: Opts = {}) {
  const seen: Record<string, Where[]> = {};
  const writes: string[] = [];
  const log = (key: string, where: Where | undefined): void => {
    (seen[key] ??= []).push(where ?? {});
  };
  const write = (name: string) => async () => {
    writes.push(name);
    return {};
  };
  const orgOf = (where: Where | undefined): unknown =>
    (where?.['project'] as Where | undefined)?.['workspaceId'];

  const client = {
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        log('user.findUnique', args.where);
        const org = USER_ORG[args.where.id];
        return org === undefined
          ? null
          : {
              id: args.where.id,
              email: `${args.where.id}@example.test`,
              name: 'N',
              accountType: 'STAFF',
              organizationId: org,
            };
      },
      findFirst: async (args: { where: { id: string } }) => {
        log('user.findFirst', args.where);
        const org = USER_ORG[args.where.id];
        return org === undefined ? null : { id: args.where.id, organizationId: org };
      },
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .filter((id) => USER_ORG[id] !== undefined)
          .map((id) => ({ id, organizationId: USER_ORG[id] })),
    },
    workspace: {
      findUnique: async (args: { where: { id: string } }) => {
        const org = WORKSPACE_ORG[args.where.id];
        return org ? { organizationId: org, organization: { baseCurrency: 'USD' } } : null;
      },
      findMany: async (args: { where?: Where }) => {
        log('workspace.findMany', args.where);
        return [];
      },
      count: async () => 0,
      create: write('workspace.create'),
    },
    workspaceMembership: {
      findFirst: async (args: { where: Where }) => {
        log('workspaceMembership.findFirst', args.where);
        const orgId = (args.where['workspace'] as Where | undefined)?.['organizationId'];
        const hit = MEMBERSHIPS.find(
          (m) =>
            m.workspaceId === args.where['workspaceId'] &&
            m.userId === args.where['userId'] &&
            WORKSPACE_ORG[m.workspaceId] === orgId,
        );
        return hit ? { id: 'm1', role: hit.role } : null;
      },
    },
    paymentSource: {
      findFirst: async (args: { where: Where }) => {
        log('paymentSource.findFirst', args.where);
        const id = args.where['id'] as string;
        return SOURCES[id] !== undefined && SOURCES[id] === args.where['organizationId']
          ? { id, defaultRegion: null }
          : null;
      },
    },
    fileObject: {
      findFirst: async (args: { where: Where }) => {
        log('fileObject.findFirst', args.where);
        const id = args.where['id'] as string;
        return FILES[id] !== undefined && FILES[id] === args.where['workspaceId'] ? { id } : null;
      },
    },
    sprint: {
      findFirst: async (args: { where: Where }) => {
        log('sprint.findFirst', args.where);
        const s = SPRINTS[args.where['id'] as string];
        if (!s || s.workspaceId !== orgOf(args.where)) return null;
        if (args.where['projectId'] !== undefined && args.where['projectId'] !== s.projectId)
          return null;
        return { id: args.where['id'] };
      },
    },
    task: {
      count: async (args: { where: Where }) => {
        log('task.count', args.where);
        const ids = (args.where['id'] as { in: string[] }).in;
        return ids.filter((id) => {
          const t = TASKS[id];
          if (!t || t.workspaceId !== orgOf(args.where)) return false;
          return args.where['projectId'] === undefined || args.where['projectId'] === t.projectId;
        }).length;
      },
    },
    goal: {
      findUnique: async (args: { where: Where }) => ({
        id: args.where['id'],
        projectId: PROJECT_A,
        workspaceId: WS_A,
      }),
      findFirst: async (args: { where: Where }) => {
        log('goal.findFirst', args.where);
        const id = args.where['id'] as string;
        return GOALS[id] !== undefined && GOALS[id] === args.where['workspaceId'] ? { id } : null;
      },
      create: write('goal.create'),
      update: write('goal.update'),
    },
    project: {
      // A project is found unless the lookup pins another workspace than the
      // one it lives in. Goals' requireProject never names a workspace.
      findFirst: async (args: { where: Where }) => {
        log('project.findFirst', args.where);
        const id = (args.where['id'] as string | undefined) ?? PROJECT_A;
        const ws = PROJECTS[id] ?? WS_A;
        const pinned = args.where['workspaceId'];
        return typeof pinned === 'string' && pinned !== ws ? null : { id, workspaceId: ws };
      },
    },
    customFieldDefinition: {
      findFirst: async (args: { where: Where }) => ({
        id: DEFINITION,
        workspaceId: args.where['workspaceId'],
        scope: 'PROJECT',
        type: 'TEXT',
        options: null,
      }),
    },
    customFieldValue: { upsert: write('customFieldValue.upsert') },
    lead: {
      findFirst: async () => ({
        id: LEAD,
        name: 'L',
        company: null,
        email: null,
        phone: null,
        assigneeId: null,
      }),
      update: write('lead.update'),
    },
    mailMessage: {
      findFirst: async (args: { where: { id: string; account: { userId: string } } }) => {
        log('mailMessage.findFirst', args.where);
        // MAIL_MSG_B lives in USER_B's mailbox.
        return args.where.id === MAIL_MSG_B && args.where.account.userId === USER_B
          ? { id: MAIL_MSG_B }
          : null;
      },
    },
    mailOutbox: { create: write('mailOutbox.create') },
    contract: {
      findFirst: async (args: { where: Where }) => {
        log('contract.findFirst', args.where);
        return {
          id: CONTRACT,
          workspaceId: WS_A,
          projectId: null,
          currency: 'USD',
        };
      },
    },
    contractMilestone: {
      findFirst: async () => ({
        id: MILESTONE,
        contractId: CONTRACT,
        contract: { id: CONTRACT, workspaceId: WS_A, projectId: null },
      }),
      aggregate: async () => ({ _max: { position: 0 } }),
      create: write('contractMilestone.create'),
      update: write('contractMilestone.update'),
    },
    milestoneTask: {
      deleteMany: write('milestoneTask.deleteMany'),
      createMany: write('milestoneTask.createMany'),
    },
    payrollItem: { findUnique: async () => null },
    expense: {
      findFirst: async () => ({
        id: EXPENSE,
        workspaceId: WS_A,
        amount: 1,
        currency: 'USD',
        fxRate: 1,
      }),
      create: write('expense.create'),
      update: write('expense.update'),
    },
    payment: {
      findFirst: async () => ({
        id: PAYMENT,
        workspaceId: WS_A,
        contractId: CONTRACT,
        voidedAt: null,
        amount: 10,
        receivedAmount: 10,
        receivedCurrency: 'USD',
        currency: 'USD',
        feeAmount: 0,
        fxRate: 1,
      }),
      create: write('payment.create'),
      update: write('payment.update'),
    },
    chatRoom: {
      create: write('chatRoom.create'),
      update: write('chatRoom.update'),
      findFirst: async (args: { where: Where }) => {
        log('chatRoom.findFirst', args.where);
        return {
          id: ROOM,
          type: 'GROUP',
          isPrivate: false,
          createdById: null,
          workspaceId: WS_A,
          workspace: { organizationId: ORG_A },
          participants: [{ id: 'p-self' }],
        };
      },
    },
    chatRoomParticipant: {
      findMany: async () => [], // legacy room: every member counts as admin
      findFirst: async (args: { where: Where }) => {
        log('chatRoomParticipant.findFirst', args.where);
        return opts.chatMember ? { id: 'p-target' } : null;
      },
      deleteMany: write('chatRoomParticipant.deleteMany'),
    },
    chatRoomMessage: { create: write('chatRoomMessage.create') },
    todo: {
      aggregate: async () => ({ _max: { sortOrder: 0 } }),
      create: write('todo.create'),
      update: write('todo.update'),
      findFirst: async () => ({ id: 'todo1', userId: USER_A, assigneeId: null, workspaceId: WS_A }),
    },
    mailAccount: {
      findFirst: write('mailAccount.findFirst'),
      findUnique: async () => ({
        id: 'cmmailacct',
        userId: USER_A,
        deletedAt: null,
        status: 'ACTIVE',
      }),
      create: write('mailAccount.create'),
      deleteMany: write('mailAccount.deleteMany'),
    },
    client: {
      findFirst: async () => ({
        id: CLIENT_ID,
        name: 'Acme',
        workspaceId: WS_A,
        workspace: { organizationId: ORG_A },
      }),
      create: write('client.create'),
    },
    clientContact: {
      findFirst: write('clientContact.findFirst'),
      create: write('clientContact.create'),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  const raw = {
    ...client,
    user: {
      ...client.user,
      findFirst: async () => opts.existingUser ?? null,
      create: write('user.create'),
      update: write('user.update'),
    },
  };
  return { prisma: { client, raw } as unknown as PrismaService, seen, writes };
}

const scopeA = {
  userId: USER_A,
  currentWorkspaceId: WS_A,
  workspaceIds: [WS_A],
  projectIds: [],
} as never;
const badRequest =
  (code: string) =>
  (err: unknown): boolean =>
    err instanceof BadRequestException && (err.getResponse() as { code?: string }).code === code;
const conflict =
  (code: string) =>
  (err: unknown): boolean =>
    err instanceof ConflictException && (err.getResponse() as { code?: string }).code === code;
const forbidden = (err: unknown): boolean => err instanceof ForbiddenException;
const notFound = (err: unknown): boolean => err instanceof NotFoundException;
const log2 = (seen: Record<string, Where[]>, key: string, where: Where): void => {
  (seen[key] ??= []).push(where);
};
const lastWhere = (seen: Record<string, Where[]>, key: string): Where => {
  const list = seen[key] ?? [];
  assert.ok(list.length > 0, `${key} was called`);
  return list[list.length - 1]!;
};

async function main(): Promise<void> {
  // --- helpers ----------------------------------------------------------------
  {
    assert.equal(
      requireTenantRef({ id: 'x' }, 'thing', 'invalid_thing').id,
      'x',
      'row passes through',
    );
    assert.throws(
      () => requireTenantRef(null, 'thing', 'invalid_thing'),
      badRequest('invalid_thing'),
      'null -> 400',
    );
    assert.throws(
      () => requireTenantRef(undefined, 'thing', 'invalid_thing'),
      badRequest('invalid_thing'),
      'undefined -> 400',
    );
    const err = invalidReference('sprint', 'invalid_sprint');
    assert.ok(err instanceof BadRequestException, 'invalidReference is a 400');
    assert.equal(
      (err.getResponse() as { title?: string }).title,
      'Invalid sprint',
      'title names the thing',
    );

    const { prisma, seen } = fakePrisma();
    assert.equal(
      await orgWorkspaceMembership(prisma, USER_NOORG, WS_A),
      null,
      'org-less user has no membership',
    );
    assert.equal(
      seen['workspaceMembership.findFirst'],
      undefined,
      'org-less user never reaches the query',
    );
    const own = await orgWorkspaceMembership(prisma, USER_A, WS_A);
    assert.equal(own?.role, 'MEMBER', 'own-org membership found');
    assert.deepEqual(
      lastWhere(seen, 'workspaceMembership.findFirst'),
      { workspaceId: WS_A, userId: USER_A, workspace: { organizationId: ORG_A } },
      'membership filtered by the user org',
    );
    assert.equal(
      await orgWorkspaceMembership(prisma, USER_A, WS_B),
      null,
      'leftover other-org membership is none',
    );

    const src = await paymentSourceForWorkspace(prisma, WS_A, SOURCE_A);
    assert.equal(src.id, SOURCE_A, 'own-org source found');
    assert.equal(
      lastWhere(seen, 'paymentSource.findFirst')['organizationId'],
      ORG_A,
      'source filtered by workspace org',
    );
    await assert.rejects(
      paymentSourceForWorkspace(prisma, WS_A, SOURCE_B),
      badRequest('invalid_payment_source'),
      'other-org source refused',
    );
    await assert.rejects(
      paymentSourceForWorkspace(prisma, 'cmnoworkspace00000000000', SOURCE_A),
      badRequest('invalid_payment_source'),
      'unknown workspace refused',
    );
  }

  // --- 1. milestones ----------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const milestones = new MilestonesService(prisma, {} as never);
    await assert.rejects(
      milestones.create(scopeA, CONTRACT, { sprintId: SPRINT_B } as never),
      badRequest('invalid_sprint'),
      'project-less contract cannot bill another workspace sprint',
    );
    assert.deepEqual(
      (lastWhere(seen, 'sprint.findFirst')['project'] as Where)['workspaceId'],
      WS_A,
      'sprint lookup pinned to the contract workspace',
    );
    await assert.rejects(
      milestones.update(scopeA, MILESTONE, { sprintId: SPRINT_B } as never),
      badRequest('invalid_sprint'),
      'update refuses other-workspace sprint',
    );
    await assert.rejects(
      milestones.linkWork(scopeA, MILESTONE, { sprintId: SPRINT_B } as never),
      badRequest('invalid_sprint'),
      'linkWork refuses other-workspace sprint',
    );
    await assert.rejects(
      milestones.linkWork(scopeA, MILESTONE, { taskIds: [TASK_A, TASK_B] } as never),
      badRequest('invalid_tasks'),
      'linkWork refuses a task of another workspace',
    );
    assert.deepEqual(
      (lastWhere(seen, 'task.count')['project'] as Where)['workspaceId'],
      WS_A,
      'task count pinned to the contract workspace',
    );
    assert.deepEqual(writes, [], 'refused milestone calls write nothing');

    // Own-workspace sprint goes through.
    const okMs = fakePrisma();
    // The read-back after the write is not faked; the write is what counts.
    await new MilestonesService(okMs.prisma, {} as never)
      .linkWork(scopeA, MILESTONE, { sprintId: SPRINT_A } as never)
      .catch(() => undefined);
    assert.ok(
      okMs.writes.includes('contractMilestone.update'),
      'linkWork with an own sprint writes',
    );

    // A contract with a project also pins the sprint to that project.
    const proj = fakePrisma();
    (proj.prisma.client as unknown as { contract: { findFirst: unknown } }).contract.findFirst =
      async () => ({
        id: CONTRACT,
        workspaceId: WS_A,
        projectId: PROJECT_A,
      });
    const scoped = new MilestonesService(proj.prisma, {} as never);
    await assert.rejects(
      scoped.create(scopeA, CONTRACT, { sprintId: SPRINT_A2 } as never),
      badRequest('invalid_sprint'),
      'sprint of a sibling project refused',
    );
    assert.equal(
      lastWhere(proj.seen, 'sprint.findFirst')['projectId'],
      PROJECT_A,
      'sprint pinned to the contract project',
    );
    assert.deepEqual(proj.writes, [], 'refused sprint writes nothing');
  }

  // --- 2. expenses ------------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const expenses = new ExpensesService(prisma, {} as never);
    const base = { description: 'Lunch', amount: '10', currency: 'USD' };
    await assert.rejects(
      expenses.create(scopeA, { ...base, paymentSourceId: SOURCE_B } as never),
      badRequest('invalid_payment_source'),
      'create: other-org payment source',
    );
    await assert.rejects(
      expenses.create(scopeA, { ...base, receiptFileId: FILE_B } as never),
      badRequest('invalid_receipt'),
      'create: other-workspace receipt',
    );
    assert.equal(
      lastWhere(seen, 'fileObject.findFirst')['workspaceId'],
      WS_A,
      'receipt pinned to the workspace',
    );
    await assert.rejects(
      expenses.update(scopeA, EXPENSE, { paymentSourceId: SOURCE_B } as never),
      badRequest('invalid_payment_source'),
      'update: other-org payment source',
    );
    await assert.rejects(
      expenses.update(scopeA, EXPENSE, { receiptFileId: FILE_B } as never),
      badRequest('invalid_receipt'),
      'update: other-workspace receipt',
    );
    assert.deepEqual(writes, [], 'refused expense calls write nothing');

    const okEx = fakePrisma();
    await new ExpensesService(okEx.prisma, {} as never).create(scopeA, {
      ...base,
      paymentSourceId: SOURCE_A,
      receiptFileId: FILE_A,
    } as never);
    assert.ok(okEx.writes.includes('expense.create'), 'create with own source and receipt writes');
  }

  // --- 3. payments ------------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const payments = new PaymentsService(prisma, {} as never, {} as never);
    await assert.rejects(
      payments.create(scopeA, {
        contractId: CONTRACT,
        amount: '10',
        currency: 'USD',
        paymentSourceId: SOURCE_B,
      } as never),
      badRequest('invalid_payment_source'),
      'create: other-org payment source',
    );
    assert.equal(
      lastWhere(seen, 'paymentSource.findFirst')['organizationId'],
      ORG_A,
      'source pinned to workspace org',
    );
    await assert.rejects(
      payments.update(scopeA, PAYMENT, { paymentSourceId: SOURCE_B } as never),
      badRequest('invalid_payment_source'),
      'update: other-org payment source',
    );
    assert.deepEqual(writes, [], 'refused payment calls write nothing');

    const okPay = fakePrisma();
    // Totals recalculation after the write is not faked; the write is what counts.
    await new PaymentsService(okPay.prisma, {} as never, {} as never)
      .create(scopeA, {
        contractId: CONTRACT,
        amount: '10',
        currency: 'USD',
        paymentSourceId: SOURCE_A,
      } as never)
      .catch(() => undefined);
    assert.ok(okPay.writes.includes('payment.create'), 'create with an own-org source writes');
  }

  // --- 4. chat removeParticipant ----------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma({ chatMember: false });
    const chat = new ChatService(prisma, {} as never);
    await assert.rejects(
      chat.removeParticipant(USER_A, ROOM, USER_B),
      notFound,
      'removing a non-member is a 404',
    );
    assert.deepEqual(
      lastWhere(seen, 'chatRoomParticipant.findFirst'),
      { roomId: ROOM, userId: USER_B },
      'membership checked for the target in this room',
    );
    assert.deepEqual(writes, [], 'no system message, no deleteMany for a non-member');

    const member = fakePrisma({ chatMember: true });
    await new ChatService(member.prisma, {} as never).removeParticipant(USER_A, ROOM, USER_B);
    assert.ok(member.writes.includes('chatRoomParticipant.deleteMany'), 'a real member is removed');

    // Channels check their participants like DMs and groups do.
    const channel = fakePrisma();
    const chat2 = new ChatService(channel.prisma, {} as never);
    await assert.rejects(
      chat2.createRoom(
        USER_A,
        {
          type: 'TEXT_CHANNEL',
          name: 'general',
          workspaceId: WS_A,
          participantUserIds: [USER_B],
        } as never,
        WS_A,
      ),
      forbidden,
      'channel create refuses a participant of another org',
    );
    assert.deepEqual(channel.writes, [], 'refused channel create writes nothing');
  }

  // --- 5. goals ---------------------------------------------------------------
  {
    const { prisma, writes } = fakePrisma();
    const goals = new GoalsService(prisma, {} as never);
    await assert.rejects(
      goals.create(scopeA, PROJECT_A, {
        title: 'g',
        ownerId: USER_A,
        parentGoalId: GOAL_B,
      } as never),
      badRequest('invalid_parent_goal'),
      'create: parent in another workspace',
    );
    await assert.rejects(
      goals.update(scopeA, GOAL_A, { parentGoalId: GOAL_B } as never),
      badRequest('invalid_parent_goal'),
      'update: parent in another workspace',
    );
    await assert.rejects(
      goals.update(scopeA, GOAL_A, { parentGoalId: GOAL_A } as never),
      badRequest('invalid_parent_goal'),
      'update: a goal cannot be its own parent',
    );
    assert.deepEqual(writes, [], 'refused goal calls write nothing');

    const okGoal = fakePrisma();
    await new GoalsService(okGoal.prisma, {} as never).create(scopeA, PROJECT_A, {
      title: 'g',
      ownerId: USER_A,
      parentGoalId: GOAL_A,
    } as never);
    assert.ok(okGoal.writes.includes('goal.create'), 'create with an own-workspace parent writes');
  }

  // --- 6. todos ---------------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const todos = new TodosService(prisma, {} as never);
    await assert.rejects(
      todos.create(USER_A, WS_A, { title: 't', workspaceId: WS_B } as never),
      forbidden,
      'leftover membership of another org does not grant workspace access',
    );
    assert.deepEqual(
      (lastWhere(seen, 'workspaceMembership.findFirst')['workspace'] as Where)['organizationId'],
      ORG_A,
      'workspace access filtered by the caller org',
    );
    await assert.rejects(
      todos.create(USER_A, WS_A, { title: 't', assigneeId: USER_B } as never),
      (e: unknown) => e instanceof BadRequestException,
      'assignee from another org refused',
    );
    assert.ok(
      MEMBERSHIPS.some((m) => m.workspaceId === WS_A && m.userId === USER_B),
      'USER_B has a leftover WS_A membership row',
    );
    await assert.rejects(
      todos.update(USER_A, 'todo1', { assigneeId: USER_B } as never),
      (e: unknown) => e instanceof BadRequestException,
      'update: assignee from another org refused',
    );
    assert.deepEqual(writes, [], 'refused todo calls write nothing');
  }

  // --- 6b. timesheets, lead conversion, mail replies, custom-field values -----
  {
    // Timesheets: the project lookup is pinned to the caller org, so USER_A's
    // leftover membership of WS_B does not make PROJECT_B reachable.
    const ts = fakePrisma();
    (ts.prisma.client as unknown as { project: { findFirst: unknown } }).project.findFirst =
      async (args: { where: { workspace: { organizationId: string } } }) => {
        log2(ts.seen, 'project.findFirst', args.where);
        return args.where.workspace.organizationId === ORG_B ? { id: PROJECT_B } : null;
      };
    const timesheets = new TimesheetsService(ts.prisma);
    const entry = { projectId: PROJECT_B, startTime: new Date(0), endTime: new Date(60_000) };
    await assert.rejects(
      timesheets.create(USER_A, WS_A, entry as never),
      (e: unknown) => e instanceof BadRequestException,
      'timesheet project of another org refused despite a leftover membership',
    );
    assert.equal(
      (lastWhere(ts.seen, 'project.findFirst')['workspace'] as Where)['organizationId'],
      ORG_A,
      'timesheet project lookup pinned to the caller org',
    );
    assert.deepEqual(ts.writes, [], 'refused timesheet writes nothing');

    // Lead conversion: the new client's assignee must be in the org.
    const lead = fakePrisma();
    const leads = new LeadsService(lead.prisma, {} as never, {} as never);
    const salesActor = {
      userId: USER_A,
      workspaceId: WS_A,
      fullAccess: true,
      fullLeads: true,
      fullClients: true,
    } as never;
    await assert.rejects(
      leads.convert(salesActor, LEAD, { newClient: { name: 'Acme', assigneeId: USER_B } } as never),
      (e: unknown) => e instanceof BadRequestException,
      'lead convert refuses a foreign assignee',
    );
    assert.deepEqual(lead.writes, [], 'refused lead convert writes nothing');

    // Mail: a reply target must sit in one of the sender's own mailboxes.
    const mailFake = fakePrisma();
    const mailSend = new MailSendService(
      mailFake.prisma,
      {} as never,
      {} as never,
      { add: async () => ({}) } as never,
    );
    await assert.rejects(
      mailSend.enqueue(USER_A, {
        accountId: 'cmmailacct',
        to: ['x@example.test'],
        subject: 's',
        bodyText: 'b',
        inReplyToMessageId: MAIL_MSG_B,
      } as never),
      badRequest('invalid_reply_target'),
      "reply to another user's message refused",
    );
    assert.deepEqual(mailFake.writes, [], 'refused reply queues nothing');

    // Custom-field values: the entity must be a project in the caller's workspace.
    const cf = fakePrisma();
    const fields = new CustomFieldsService(cf.prisma);
    await assert.rejects(
      fields.setValue(
        scopeA,
        { can: () => true } as never,
        { definitionId: DEFINITION, entityId: PROJECT_B, value: 'x' } as never,
      ),
      badRequest('invalid_entity'),
      'custom-field value on a project of another workspace refused',
    );
    assert.equal(
      lastWhere(cf.seen, 'project.findFirst')['workspaceId'],
      WS_A,
      'entity lookup pinned to the workspace',
    );
    assert.deepEqual(cf.writes, [], 'refused custom-field value writes nothing');
  }

  // --- 7. LiveKit -------------------------------------------------------------
  {
    const { prisma, seen } = fakePrisma({});
    const config = { get: () => 'x' };
    // The fake room is a public text channel of WS_B.
    (prisma.client as unknown as { chatRoom: { findFirst: unknown } }).chatRoom.findFirst =
      async () => ({
        id: ROOM,
        type: 'TEXT_CHANNEL',
        isPrivate: false,
        workspaceId: WS_B,
        participants: [],
      });
    const livekit = new LivekitService(prisma, config as never);
    await assert.rejects(
      livekit.mintToken(USER_A, { roomId: ROOM, kind: 'call' } as never),
      forbidden,
      'leftover other-org membership does not open a public channel',
    );
    assert.deepEqual(
      (lastWhere(seen, 'workspaceMembership.findFirst')['workspace'] as Where)['organizationId'],
      ORG_A,
      'channel membership filtered by the caller org',
    );
  }

  // --- 8. workspace-role guard ------------------------------------------------
  {
    const { prisma, seen } = fakePrisma();
    const reflector = { getAllAndOverride: () => ['ADMIN'] } as unknown as Reflector;
    const guard = new WorkspaceRoleGuard(reflector, prisma);
    const ctxFor = (workspaceId: string, memberships: unknown[] = []): ExecutionContext =>
      ({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { id: USER_A },
            headers: { 'x-workspace-id': workspaceId },
            workspaceMemberships: memberships,
          }),
        }),
      }) as unknown as ExecutionContext;
    await assert.rejects(
      guard.canActivate(ctxFor(WS_B)),
      forbidden,
      'DB fallback ignores a leftover ADMIN membership of another org',
    );
    assert.deepEqual(
      (lastWhere(seen, 'workspaceMembership.findFirst')['workspace'] as Where)['organizationId'],
      ORG_A,
      'guard fallback filtered by the caller org',
    );
    await assert.rejects(
      guard.canActivate(ctxFor(WS_A)),
      forbidden,
      'own-org MEMBER lacks the ADMIN role',
    );
    assert.equal(
      await guard.canActivate(ctxFor(WS_A, [{ workspaceId: WS_A, role: 'ADMIN' }])),
      true,
      'AuthGuard-resolved membership still passes',
    );
  }

  // --- 9. workspaces ----------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const workspaces = new WorkspacesService(prisma, {} as never, {} as never, {} as never);
    const query = { page: 1, pageSize: 20 } as never;
    await workspaces.listForUser(USER_A, query);
    assert.equal(
      lastWhere(seen, 'workspace.findMany')['organizationId'],
      ORG_A,
      'list pinned to the caller org',
    );
    await workspaces.listForUser(USER_NOORG, query);
    assert.notEqual(
      lastWhere(seen, 'workspace.findMany')['organizationId'],
      ROOT_ORG_ID,
      'org-less list never falls back to the root org',
    );
    assert.equal(
      lastWhere(seen, 'workspace.findMany')['organizationId'],
      '__none__',
      'org-less list matches nothing',
    );
    await assert.rejects(
      workspaces.create(USER_NOORG, { name: 'W', slug: 'w' } as never),
      forbidden,
      'org-less creator refused',
    );
    assert.deepEqual(writes, [], 'refused workspace create writes nothing');
  }

  // --- 10. mailbox self-setup -------------------------------------------------
  {
    const { prisma, writes } = fakePrisma();
    (prisma.client as unknown as { user: { findUnique: unknown } }).user.findUnique = async (args: {
      where: { id: string };
    }) => ({
      email: 'someone@example.test',
      name: 'N',
      organizationId: args.where.id === USER_A ? ORG_A : ROOT_ORG_ID,
    });
    let cpanelCalls = 0;
    const cpanel = {
      isEnabled: () => true,
      ownsEmail: () => {
        cpanelCalls += 1;
        return false; // stop right after the org check for the root user
      },
      setPassword: async () => {
        cpanelCalls += 1;
      },
    };
    const mail = new MailAccountsService(
      prisma,
      {} as never,
      {} as never,
      cpanel as never,
      {} as never,
      {} as never,
    );
    await assert.rejects(
      mail.selfSetup(WS_A, USER_A, 'password-123'),
      (e: unknown) =>
        e instanceof ForbiddenException &&
        (e.getResponse() as { code?: string }).code === 'cpanel-platform-only',
      'tenant user refused with cpanel-platform-only',
    );
    assert.equal(cpanelCalls, 0, 'refused tenant user never touches cPanel');
    await assert.rejects(
      mail.selfSetup(WS_A, USER_B, 'password-123'),
      (e: unknown) =>
        e instanceof ForbiddenException &&
        (e.getResponse() as { code?: string }).code !== 'cpanel-platform-only',
      'root-org user gets past the org check',
    );
    assert.deepEqual(writes, [], 'refused mailbox setup writes nothing');
  }

  // --- 11. client-portal invite ----------------------------------------------
  {
    const actor = { userId: USER_A, workspaceId: WS_A } as never;
    const workspaces = { canAdminister: async () => true };
    const invite = async (existingUser: Record<string, unknown>) => {
      const { prisma, writes } = fakePrisma({ existingUser });
      const svc = new ClientPortalService(
        prisma,
        {} as never,
        workspaces as never,
        {} as never,
        {} as never,
        {} as never,
      );
      return {
        run: svc.invite(actor, CLIENT_ID, { email: 'Person@Example.test' } as never),
        writes,
      };
    };
    const row = (extra: Record<string, unknown>) => ({
      id: 'cmexisting',
      name: 'P',
      accountType: 'STAFF',
      organizationId: ORG_A,
      deletedAt: null,
      accounts: [],
      ...extra,
    });

    let r = await invite(row({}));
    await assert.rejects(r.run, conflict('staff-account'), 'same-org staff account is named');
    assert.deepEqual(r.writes, [], 'same-org refusal writes nothing');

    r = await invite(row({ organizationId: ORG_B }));
    await assert.rejects(
      r.run,
      conflict('email-unavailable'),
      'other-org staff account is generic',
    );
    assert.deepEqual(r.writes, [], 'other-org staff refusal writes nothing');

    r = await invite(row({ organizationId: null }));
    await assert.rejects(r.run, conflict('email-unavailable'), 'org-less staff account is generic');

    r = await invite(row({ accountType: 'CLIENT', organizationId: ORG_B, deletedAt: new Date() }));
    await assert.rejects(
      r.run,
      conflict('email-unavailable'),
      'disabled account elsewhere is generic',
    );
    assert.deepEqual(r.writes, [], 'disabled-account refusal writes nothing');
  }

  console.log('check-tenant-scope: OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
