/**
 * Platform-admin privacy self-checks (no database): a SUPER_ADMIN manages
 * organizations but never reaches into one. Each service runs against a fake
 * Prisma inside a request context carrying a SUPER_ADMIN snapshot. Covered:
 * user admin, chat (contacts, DM, add members, admin rooms, admin delete),
 * workspace admin, leaves, attendance, timesheets, the org audit log and the
 * platform log - reads pinned to the root org, writes refused.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { presetPermissions } from '@botss/auth';
import { PLATFORM_AUDIT_ACTIONS, type CreateChatRoomInput } from '@botss/shared-types';
import type { Request, Response } from 'express';

import { AdminUsersService } from '../admin/admin-users.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ChatService } from '../chat/chat.service';
import { RequestContextMiddleware, setRequestAuth } from '../common/request-context';
import { AttendanceService } from '../hr/attendance.service';
import { LeavesService } from '../hr/leaves.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import type { PrismaService } from '../prisma/prisma.service';
import { TimesheetsService } from '../timesheets/timesheets.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

const ORG_B = 'cmorgb000000000000000000b';
const SUPER = 'cmsuper00000000000000000a';
const TENANT_ADMIN = 'cmtadmin0000000000000000b';
const TENANT_USER = 'cmtenant0000000000000000b';
const WS_B = 'cmwsb0000000000000000000b';
const WS_ROOT = 'cmwsroot00000000000000000';
const ROOM_B = 'cmroomb000000000000000000';
const LEAVE_B = 'cmleaveb00000000000000000';
const GONE_ORG = 'cmgoneorg0000000000000000';

const USERS: Record<string, { systemRole: string; organizationId: string }> = {
  [SUPER]: { systemRole: 'SUPER_ADMIN', organizationId: ROOT_ORG_ID },
  [TENANT_ADMIN]: { systemRole: 'ADMIN', organizationId: ORG_B },
  [TENANT_USER]: { systemRole: 'EMPLOYEE', organizationId: ORG_B },
};
const WORKSPACES: Record<string, { organizationId: string }> = {
  [WS_B]: { organizationId: ORG_B },
};

type Where = Record<string, unknown>;

/**
 * Records the `where` of every findMany so a check can inspect the scope.
 * `auditRows` seeds `auditLog.findMany`; `writes` lists every write a refused
 * request must never reach; `rawSql` holds the values of each raw query.
 */
function fakePrisma(auditRows: unknown[] = []) {
  const seen: Record<string, Where[]> = {};
  const writes: string[] = [];
  const rawSql: unknown[][] = [];
  const record = (model: string) => async (args: { where?: Where }) => {
    (seen[model] ??= []).push(args.where ?? {});
    return [];
  };
  const write = (name: string) => async () => {
    writes.push(name);
    return {};
  };
  const user = (id: string) => {
    const u = USERS[id];
    return u
      ? {
          id,
          email: `${id}@example.test`,
          name: id,
          accountType: 'STAFF',
          ...u,
          organization: { isRoot: u.organizationId === ROOT_ORG_ID },
          clientContacts: [],
        }
      : null;
  };
  const client = {
    user: {
      findUnique: async (args: { where: { id?: string; email?: string } }) =>
        args.where.id ? user(args.where.id) : null,
      findMany: async (args: { where?: Where }) => {
        (seen['user'] ??= []).push(args.where ?? {});
        const ids = (args.where?.['id'] as { in?: string[] } | undefined)?.in;
        return ids ? ids.flatMap((id) => (user(id) ? [user(id)] : [])) : [];
      },
    },
    workspace: {
      findUnique: async (args: { where: { id: string } }) => WORKSPACES[args.where.id] ?? null,
      findMany: record('workspace'),
    },
    leave: {
      findMany: record('leave'),
      // Another org's leave: every SUPER_ADMIN action on it must be refused.
      findUnique: async () => ({ id: LEAVE_B, userId: TENANT_USER, status: 'PENDING' }),
      update: write('leave.update'),
      delete: write('leave.delete'),
    },
    attendance: { upsert: write('attendance.upsert') },
    chatRoom: {
      // A group channel of another org, with SUPER somehow a member and admin.
      findFirst: async () => ({
        id: ROOM_B,
        type: 'GROUP',
        isPrivate: false,
        workspaceId: WS_B,
        workspace: { organizationId: ORG_B },
        participants: [{ id: 'p1', user: { organizationId: ORG_B } }],
      }),
      findMany: record('chatRoom'),
      update: write('chatRoom.update'),
    },
    chatRoomParticipant: {
      findMany: async () => [{ userId: SUPER, role: 'ADMIN' }],
      createMany: write('chatRoomParticipant.createMany'),
    },
    timeEntry: { findMany: record('timeEntry') },
    auditLog: {
      findMany: async (args: { where?: Where }) => {
        (seen['auditLog'] ??= []).push(args.where ?? {});
        return auditRows;
      },
      count: async () => auditRows.length,
    },
    // Name lookups for audit rows.
    clientContact: { findMany: record('clientContact') },
    client: { findMany: record('client') },
    project: { findMany: record('project') },
    document: { findMany: record('document') },
    role: { findMany: record('role') },
    organization: { findMany: record('organization') },
  };
  const raw = {
    ...client,
    // Tagged-template call: (strings, ...values). Nested Prisma.sql
    // fragments carry their own `values`, which JSON.stringify keeps.
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      rawSql.push(values);
      return [];
    },
  };
  return { prisma: { client, raw } as unknown as PrismaService, seen, writes, rawSql };
}

/** Run `fn` as the SUPER_ADMIN, the way AuthGuard leaves a request. */
function asSuperAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new RequestContextMiddleware().use({} as Request, {} as Response, () => {
      setRequestAuth({
        userId: SUPER,
        systemRole: 'SUPER_ADMIN',
        organizationId: ROOT_ORG_ID,
        permissions: presetPermissions({ systemRole: 'SUPER_ADMIN' }),
      });
      fn().then(resolve, reject);
    });
  });
}

const forbidden = (err: unknown): boolean => err instanceof ForbiddenException;
const notFound = (err: unknown): boolean => err instanceof NotFoundException;
const lastWhere = (seen: Record<string, Where[]>, model: string): Where => {
  const list = seen[model] ?? [];
  assert.ok(list.length > 0, `${model}.findMany was called`);
  return list[list.length - 1]!;
};

async function main(): Promise<void> {
  // --- users ----------------------------------------------------------------
  {
    const { prisma, seen } = fakePrisma();
    let cpanelPasswordChanged = false;
    const cpanel = {
      isEnabled: () => true,
      ownsEmail: () => true,
      listEmails: async () => [{ email: 'mbx@example.test' }],
      setPassword: async () => {
        cpanelPasswordChanged = true;
      },
    };
    const audit = { emit: async () => undefined };
    const users = new AdminUsersService(
      prisma,
      {} as never,
      cpanel as never,
      audit as unknown as AuditLogService,
      {} as never,
    );
    await asSuperAdmin(async () => {
      await users.list(SUPER);
      assert.equal(lastWhere(seen, 'user')['organizationId'], ROOT_ORG_ID, 'user list pinned to root');

      await assert.rejects(users.update(SUPER, TENANT_USER, { name: 'x' }), forbidden, 'edit other org user');
      await assert.rejects(
        users.update(SUPER, TENANT_USER, { password: 'new-password-1' }),
        forbidden,
        'password reset of other org user',
      );
      await assert.rejects(users.remove(SUPER, TENANT_USER), forbidden, 'delete other org user');
      await assert.rejects(
        users.create(SUPER, null, {
          email: 'new@example.test',
          name: 'New',
          password: 'password-123',
          systemRole: 'EMPLOYEE',
          workspaceId: WS_B,
        }),
        forbidden,
        'create into other org workspace',
      );
      await assert.rejects(
        users.importWebmailUser(SUPER, null, {
          email: 'mbx@example.test',
          name: 'Mailbox',
          password: 'password-123',
          systemRole: 'EMPLOYEE',
          workspaceId: WS_B,
        }),
        forbidden,
        'import into other org workspace',
      );
      assert.equal(cpanelPasswordChanged, false, 'refused import changes no cPanel password');
    });
  }

  // --- chat -----------------------------------------------------------------
  {
    const { prisma, seen, writes } = fakePrisma();
    const chat = new ChatService(prisma, {} as never);
    const superActor = { systemRole: 'SUPER_ADMIN', organizationId: ROOT_ORG_ID };
    await asSuperAdmin(async () => {
      await chat.listContactsForUser(SUPER);
      assert.equal(lastWhere(seen, 'user')['organizationId'], ROOT_ORG_ID, 'contacts pinned to root');
      const dm = { type: 'DM', participantUserIds: [TENANT_USER] } as CreateChatRoomInput;
      await assert.rejects(chat.createRoom(SUPER, dm, null), forbidden, 'DM into other org');

      await assert.rejects(
        chat.addParticipants(SUPER, ROOM_B, [TENANT_USER]),
        forbidden,
        'add other org user to a channel',
      );
      await chat.listAdminRoomsForWorkspace(WS_ROOT, superActor);
      assert.deepEqual(
        lastWhere(seen, 'chatRoom')['OR'],
        [
          { workspaceId: WS_ROOT, workspace: { organizationId: ROOT_ORG_ID } },
          {
            workspaceId: null,
            type: { in: ['DM', 'GROUP'] },
            participants: { some: { user: { organizationId: ROOT_ORG_ID } } },
            // And no participant outside root (cross-org DMs stay out).
            NOT: {
              participants: {
                some: {
                  user: {
                    OR: [{ organizationId: null }, { organizationId: { not: ROOT_ORG_ID } }],
                  },
                },
              },
            },
          },
        ],
        'admin rooms pinned to root (no platform-wide DMs/groups)',
      );
      await assert.rejects(chat.adminDeleteRoom(ROOM_B, superActor), notFound, 'delete other org room');
    });
    assert.deepEqual(writes, [], 'refused chat actions write nothing');
  }

  // --- workspaces -----------------------------------------------------------
  {
    const { prisma } = fakePrisma();
    const workspaces = new WorkspacesService(prisma, {} as never, {} as never, {} as never);
    const isOrgAdminFor = (
      workspaces as unknown as { isOrgAdminFor(ws: string, user: string): Promise<boolean> }
    ).isOrgAdminFor.bind(workspaces);
    await asSuperAdmin(async () => {
      assert.equal(await isOrgAdminFor(WS_B, SUPER), false, 'no admin over other org workspace');
    });
  }

  // --- HR -------------------------------------------------------------------
  {
    const { prisma, seen, writes, rawSql } = fakePrisma();
    const admin = { assertAdminOrHR: async () => undefined } as unknown as AdminUsersService;
    const leaves = new LeavesService(prisma, {} as never);
    const attendance = new AttendanceService(prisma, admin, leaves);
    const timesheets = new TimesheetsService(prisma);
    const day = new Date('2026-10-01T00:00:00.000Z');
    await asSuperAdmin(async () => {
      await leaves.list(SUPER, {});
      assert.deepEqual(lastWhere(seen, 'leave')['user'], { organizationId: ROOT_ORG_ID }, 'leaves pinned');
      await assert.rejects(leaves.list(SUPER, { userId: TENANT_USER }), forbidden, 'other org leaves');
      await assert.rejects(
        leaves.create(SUPER, { userId: TENANT_USER, startDate: day, endDate: day, type: 'ANNUAL' } as never),
        forbidden,
        'file leave for other org user',
      );
      await assert.rejects(
        leaves.updateStatus(SUPER, LEAVE_B, { status: 'APPROVED' }),
        forbidden,
        'approve other org leave',
      );
      await assert.rejects(leaves.remove(SUPER, LEAVE_B), forbidden, 'delete other org leave');

      await attendance.listUsers(SUPER);
      assert.equal(lastWhere(seen, 'user')['organizationId'], ROOT_ORG_ID, 'attendance users pinned');
      await assert.rejects(
        attendance.summary(SUPER, { userId: TENANT_USER, from: day, to: day } as never),
        forbidden,
        'other org attendance summary',
      );
      await assert.rejects(
        attendance.override(SUPER, { userId: TENANT_USER, date: day, status: 'PRESENT' } as never),
        forbidden,
        'override other org attendance',
      );

      await timesheets.adminList(SUPER, {});
      assert.deepEqual(
        lastWhere(seen, 'timeEntry')['user'],
        { organizationId: ROOT_ORG_ID },
        'time entries pinned',
      );
      await assert.rejects(
        timesheets.list(SUPER, WS_ROOT, { userId: TENANT_USER } as never),
        forbidden,
        'other org timesheet',
      );
      await timesheets.adminAttendance(SUPER, day, day);
      const sqlValues = JSON.stringify(rawSql[rawSql.length - 1] ?? []);
      assert.ok(sqlValues.includes(ROOT_ORG_ID), 'attendance grid SQL filtered to root org');
    });
    assert.deepEqual(writes, [], 'refused HR actions write nothing');
  }

  // --- audit log ------------------------------------------------------------
  {
    const { prisma, seen } = fakePrisma();
    const auditLog = new AuditLogService(prisma);
    await asSuperAdmin(async () => {
      await auditLog.list(SUPER, { page: 1, pageSize: 50 });
      assert.equal(lastWhere(seen, 'auditLog')['organizationId'], ROOT_ORG_ID, 'org log pinned to root');

      await auditLog.listPlatform(SUPER, { page: 1, pageSize: 50 });
      const platform = lastWhere(seen, 'auditLog');
      assert.deepEqual(platform['action'], { in: [...PLATFORM_AUDIT_ACTIONS] }, 'org-level actions only');
      assert.ok(!('organizationId' in platform), 'platform log spans organizations');

      await auditLog.listPlatform(SUPER, { page: 1, pageSize: 50, action: 'user.role_change' });
      assert.deepEqual(lastWhere(seen, 'auditLog')['action'], { in: [] }, 'action filter cannot widen');
    });
    await assert.rejects(
      auditLog.listPlatform(TENANT_ADMIN, { page: 1, pageSize: 50 }),
      forbidden,
      'platform log is super admin only',
    );
  }
  {
    // A hard-deleted org's tombstone lives in the root org; the platform log
    // must name the purged org (from metadata), not the root org.
    const { prisma } = fakePrisma([
      {
        id: 'cmauditrow000000000000001',
        organizationId: ROOT_ORG_ID,
        actorUserId: null,
        action: 'org.hard_delete',
        target: `organization:${GONE_ORG}`,
        metadata: { purgedOrgId: GONE_ORG, name: 'Acme Ltd' },
        createdAt: new Date(),
        actorUser: null,
      },
    ]);
    const auditLog = new AuditLogService(prisma);
    const page = await asSuperAdmin(() => auditLog.listPlatform(SUPER, { page: 1, pageSize: 50 }));
    assert.equal(page.items[0]?.organizationName, 'Acme Ltd', 'hard-deleted org named from metadata');
  }

  {
    // A security alert raised inside a tenant: the platform log shows the
    // count and the organization, never who did it or who was affected.
    const tenantActor = { id: TENANT_ADMIN, name: 'Tenant Admin', email: 'tadmin@example.test', image: null };
    const { prisma, seen } = fakePrisma([
      {
        id: 'cmauditrow000000000000002',
        organizationId: ORG_B,
        actorUserId: TENANT_ADMIN,
        action: 'security.new_admin',
        target: `user:${TENANT_USER}`,
        metadata: { userId: TENANT_USER, scope: 'system', role: 'ADMIN' },
        createdAt: new Date(),
        actorUser: tenantActor,
      },
      {
        id: 'cmauditrow000000000000003',
        organizationId: ORG_B,
        actorUserId: TENANT_ADMIN,
        action: 'security.mass_delete',
        target: null,
        metadata: { count: 60, windowMinutes: 10, userId: TENANT_ADMIN },
        createdAt: new Date(),
        actorUser: tenantActor,
      },
    ]);
    const auditLog = new AuditLogService(prisma);
    const page = await asSuperAdmin(() =>
      auditLog.listPlatform(SUPER, {
        page: 1,
        pageSize: 50,
        search: 'tadmin',
        actorUserId: TENANT_ADMIN,
      }),
    );
    assert.equal(page.items.length, 2);
    for (const item of page.items) {
      assert.equal(item.actorUser, null, `${item.action}: no tenant actor`);
      assert.equal(item.actorUserId, null, `${item.action}: no tenant actor id`);
      assert.deepEqual(item.labels, {}, `${item.action}: no resolved names`);
      assert.equal(item.targetLabel, null, `${item.action}: no target user`);
      assert.equal(item.target, null, `${item.action}: no target id`);
      assert.ok(!('userId' in item.metadata), `${item.action}: no user id in metadata`);
      assert.ok(!JSON.stringify(item).includes(TENANT_ADMIN), `${item.action}: actor id absent`);
      assert.ok(!JSON.stringify(item).includes(TENANT_USER), `${item.action}: target id absent`);
    }
    assert.equal(page.items[1]?.metadata['count'], 60, 'alert keeps its count');
    const where = lastWhere(seen, 'auditLog');
    assert.ok(!('actorUserId' in where), 'platform log ignores the actor filter');
    assert.ok(
      !JSON.stringify(where['OR'] ?? []).includes('actorUser'),
      'platform search does not match actor name or email',
    );
  }

  console.log('check-platform-admin-privacy: OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
