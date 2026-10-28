/**
 * Support access self-checks (no database): the real AuthGuard with a fake
 * AuthService, and the real SupportSessionService / SupportService against
 * a fake Prisma. Covered:
 *
 * - no grant, an expired grant, a revoked grant: refused
 * - a write in a support session: refused, and still recorded
 * - a read: allowed, runs inside the granted org as a read only viewer, and
 *   is recorded in that org's audit log (method + path, no query string)
 * - a token that is forged, edited, or used by another user or session
 * - a non super admin can't use support mode or open a session
 * - normal requests are unaffected (no grant lookup, no audit row)
 * - a grant longer than 30 days, or ending in the past, is refused
 * - grant management needs `org.settings`; the platform log strips actors
 * - chat attachments never show in `/files`; the content route serves the
 *   active workspace to normal users, and only a normalized inline type
 * - errors never echo or log the query string (`?st=`); no request store
 *   fails a support request closed
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { type ExecutionContext, HttpException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { SUPPORT_SESSION_PERMISSIONS, type EffectivePermissions } from '@botss/auth';
import { prisma as extendedPrisma, rawPrisma } from '@botss/database';
import {
  createSupportGrantSchema,
  listAuditLogQuerySchema,
  listExpensesQuerySchema,
  PLATFORM_AUDIT_ACTIONS,
  SUPPORT_TOKEN_HEADER,
  type AuditLogEntry,
} from '@botss/shared-types';
import type { Request, Response } from 'express';

import { AppModule } from '../app.module';
import { AuditLogService, platformSafeEntry } from '../audit-log/audit-log.service';
import { AuthContextCache } from '../auth/auth-context-cache';
import { SupportTokenInQuery } from '../common/decorators/support-token-query.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { AuthGuard, type RequestExtensions } from '../common/guards/auth.guard';
import { GlobalAdmin, GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { loadEffectivePermissions } from '../common/permissions/effective-permissions';
import { abilityForRequest } from '../common/permissions/request-ability';
import {
  clearRequestAuth,
  isSupportRequest,
  RequestContextMiddleware,
  requestAuthFor,
  setRequestAuth,
} from '../common/request-context';
import { ProblemDetailsExceptionFilter } from '../common/filters/problem-details.filter';
import { contentWorkspaceIds, inlineContentType } from '../files/files.controller';
import { FilesService, generalFileVisibility } from '../files/files.service';
import { ExpensesService } from '../finance/expenses.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { SearchService } from '../search/search.service';
import { collectFileLinkKeys, rewriteFileLinks } from '../support/support-file-links';
import { SupportFileLinksInterceptor } from '../support/support-file-links.interceptor';
import {
  isSupportExcludedPath,
  SUPPORT_EXCLUDED_PREFIXES,
  supportAccessPath,
} from '../support/support-rules';
import { SupportSessionService } from '../support/support-session.service';
import { signSupportToken } from '../support/support-token';
import { assertSupportWriteAllowed } from '../support/support-write-backstop';
import { SupportModule } from '../support/support.module';
import { SupportService } from '../support/support.service';

process.env.BETTER_AUTH_SECRET = 'check-support-access-secret-0123456789';
const SECRET = process.env.BETTER_AUTH_SECRET;

const ORG_B = 'cmorgb000000000000000000b';
const ORG_C = 'cmorgc000000000000000000c';
const SUPER = 'cmsuper00000000000000000a';
const SUPER_2 = 'cmsuper00000000000000000b';
const ROOT_EMPLOYEE = 'cmrootemp000000000000000a';
const TENANT_ADMIN = 'cmtadmin0000000000000000b';
const WS_B1 = 'cmwsb1000000000000000000b';
const WS_B2 = 'cmwsb2000000000000000000b';
const WS_ROOT = 'cmwsroot00000000000000000';
const SESSION = 'session-super-1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

type Extras = {
  systemRole: 'SUPER_ADMIN' | 'ADMIN' | 'EMPLOYEE';
  organizationId: string;
  accountType: 'STAFF' | 'CLIENT';
};
const USERS: Record<string, Extras> = {
  [SUPER]: { systemRole: 'SUPER_ADMIN', organizationId: ROOT_ORG_ID, accountType: 'STAFF' },
  [SUPER_2]: { systemRole: 'SUPER_ADMIN', organizationId: ROOT_ORG_ID, accountType: 'STAFF' },
  [ROOT_EMPLOYEE]: { systemRole: 'EMPLOYEE', organizationId: ROOT_ORG_ID, accountType: 'STAFF' },
  [TENANT_ADMIN]: { systemRole: 'ADMIN', organizationId: ORG_C, accountType: 'STAFF' },
};

interface GrantRow {
  id: string;
  organizationId: string;
  grantedById: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedById: string | null;
  readOnly: boolean;
  reason: string | null;
  createdAt: Date;
}

const ORGS: Record<
  string,
  { name: string; isActive: boolean; deletedAt: Date | null; workspaces: string[] }
> = {
  [ORG_B]: { name: 'Org B', isActive: true, deletedAt: null, workspaces: [WS_B1, WS_B2] },
  [ORG_C]: { name: 'Org C', isActive: true, deletedAt: null, workspaces: [] },
};

type Where = {
  id?: string;
  organizationId?: string;
  revokedAt?: null;
  expiresAt?: { gt: Date };
  organization?: { deletedAt?: null; isActive?: boolean };
};

function matches(g: GrantRow, where: Where): boolean {
  if (where.id !== undefined && g.id !== where.id) return false;
  if (where.organizationId !== undefined && g.organizationId !== where.organizationId) return false;
  if (where.revokedAt === null && g.revokedAt !== null) return false;
  if (where.expiresAt && !(g.expiresAt.getTime() > where.expiresAt.gt.getTime())) return false;
  if (where.organization) {
    const org = ORGS[g.organizationId];
    if (!org) return false;
    if (where.organization.deletedAt === null && org.deletedAt !== null) return false;
    if (where.organization.isActive !== undefined && org.isActive !== where.organization.isActive)
      return false;
  }
  return true;
}

/** In-memory SupportGrant + AuditLog + User, enough for the support code. */
function fakePrisma(opts: { auditFails?: boolean } = {}) {
  const grants: GrantRow[] = [];
  const audit: Array<{
    id?: string;
    organizationId: string;
    actorUserId: string | null;
    action: string;
    target?: string | null;
    metadata: unknown;
  }> = [];
  const calls = { grantReads: 0 };
  const userSummary = (id: string | null) =>
    id ? { id, name: id, email: `${id}@example.test`, image: null } : null;
  const shape = (g: GrantRow) => {
    const org = ORGS[g.organizationId]!;
    return {
      ...g,
      grantedBy: userSummary(g.grantedById),
      revokedBy: userSummary(g.revokedById),
      organization: {
        name: org.name,
        isActive: org.isActive,
        deletedAt: org.deletedAt,
        workspaces: org.workspaces.map((id) => ({ id })),
      },
    };
  };
  let seq = 0;
  const client = {
    supportGrant: {
      findFirst: async (args: { where: Where }) => {
        calls.grantReads++;
        const g = grants.find((row) => matches(row, args.where));
        return g ? shape(g) : null;
      },
      findMany: async (args: { where: Where; orderBy?: { expiresAt?: 'asc' | 'desc' } }) => {
        calls.grantReads++;
        const hit = grants.filter((row) => matches(row, args.where));
        const dir = args.orderBy?.expiresAt;
        if (dir)
          hit.sort(
            (a, b) => (a.expiresAt.getTime() - b.expiresAt.getTime()) * (dir === 'asc' ? 1 : -1),
          );
        return hit.map(shape);
      },
      create: async (args: {
        data: Omit<GrantRow, 'id' | 'createdAt' | 'revokedAt' | 'revokedById'>;
      }) => {
        seq++;
        const row: GrantRow = {
          id: `cmgrant${String(seq).padStart(18, '0')}`,
          revokedAt: null,
          revokedById: null,
          createdAt: new Date(),
          ...args.data,
        };
        grants.push(row);
        return shape(row);
      },
      updateMany: async (args: {
        where: Where;
        data: { revokedAt: Date; revokedById: string };
      }) => {
        const hit = grants.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
    },
    auditLog: {
      create: async (args: { data: (typeof audit)[number] }) => {
        if (opts.auditFails) throw new Error('db down');
        audit.push(args.data);
        return { id: `cmaudit${String(audit.length).padStart(18, '0')}` };
      },
      updateMany: async (args: {
        where: { id: string; organizationId: string; action: string };
        data: { metadata: unknown };
      }) => {
        const index = Number(args.where.id.slice('cmaudit'.length)) - 1;
        const row = audit[index];
        if (
          !row ||
          row.organizationId !== args.where.organizationId ||
          row.action !== args.where.action
        ) {
          return { count: 0 };
        }
        row.metadata = args.data.metadata;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async (args: { where: { id: string } }) => {
        const u = USERS[args.where.id];
        return u ? { id: args.where.id, ...u } : null;
      },
    },
  };
  const addGrant = (row: Partial<GrantRow> & { organizationId: string }): GrantRow => {
    seq++;
    const full: GrantRow = {
      id: `cmgrant${String(seq).padStart(18, '0')}`,
      grantedById: TENANT_ADMIN,
      expiresAt: new Date(Date.now() + DAY),
      revokedAt: null,
      revokedById: null,
      readOnly: true,
      reason: null,
      createdAt: new Date(),
      ...row,
    };
    grants.push(full);
    return full;
  };
  return { prisma: { client } as unknown as PrismaService, grants, audit, calls, addGrant };
}

class Handler {
  handle(): void {}
  @SupportTokenInQuery()
  content(): void {}
}

class AdminHandler {
  @GlobalAdmin()
  handle(): void {}
}

/** Run `fn` inside a request store marked as a support session of SUPER in ORG_B. */
function asSupport<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new RequestContextMiddleware().use({} as Request, {} as Response, () => {
      const permissions: EffectivePermissions = {
        company: [...SUPPORT_SESSION_PERMISSIONS.company],
        workspace: [...SUPPORT_SESSION_PERMISSIONS.workspace],
      };
      setRequestAuth(
        { userId: SUPER, systemRole: 'EMPLOYEE', organizationId: ORG_B, permissions },
        { support: { userId: SUPER, workspaceIds: [WS_B1, WS_B2] } },
      );
      fn().then(resolve, reject);
    });
  });
}

/** Run the real AuthGuard for one request. */
async function runGuard(args: {
  prisma: PrismaService;
  userId: string;
  sessionId?: string;
  method?: string;
  url?: string;
  headers?: Record<string, string | string[]>;
  query?: Record<string, unknown>;
  handler?: () => void;
  response?: EventEmitter & { statusCode?: number };
  withSupportService?: boolean;
  /** Run outside any request store (no AsyncLocalStorage context). */
  noStore?: boolean;
}) {
  const calls = { context: 0, contextWs: [] as Array<string | undefined> };
  const fakeAuth = {
    getSessionFromRequest: async () => ({
      user: {
        id: args.userId,
        email: `${args.userId}@example.test`,
        name: args.userId,
        emailVerified: true,
        image: null,
      },
      session: { id: args.sessionId ?? SESSION },
    }),
    resolveRequestContext: async (userId: string, ws?: string) => {
      calls.context++;
      calls.contextWs.push(ws);
      const u = USERS[userId]!;
      return {
        extras: { ...u, orgInactive: false, userDisabled: false },
        session: {
          currentWorkspaceId: WS_ROOT,
          workspaceMemberships: [{ workspaceId: WS_ROOT, role: 'OWNER' }],
          projectMemberships: [],
        },
        permissions: { company: ['org.settings', 'users.manage'], workspace: ['workspace.view'] },
      };
    },
    ensureBootstrapWorkspace: async () => WS_ROOT,
  };
  const support =
    args.withSupportService === false ? undefined : new SupportSessionService(args.prisma);
  const guard = new AuthGuard(new Reflector(), fakeAuth as never, support);
  const req: Record<string, unknown> = {
    headers: args.headers ?? {},
    query: args.query ?? {},
    method: args.method ?? 'GET',
    url: args.url ?? '/api/v1/projects',
    originalUrl: args.url ?? '/api/v1/projects',
  };
  const ctx = {
    getHandler: () => args.handler ?? Handler.prototype.handle,
    getClass: () => Handler,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => args.response }),
  } as unknown as ExecutionContext;
  let status: number | null = null;
  let code: unknown = null;
  let snapshotOrg: string | null | undefined;
  await new Promise<void>((resolve, reject) => {
    const run = () =>
      guard
        .canActivate(ctx)
        .then(() => {
          snapshotOrg = requestAuthFor(args.userId)?.organizationId;
        })
        .catch((err: unknown) => {
          if (err instanceof HttpException) {
            status = err.getStatus();
            code = (err.getResponse() as { code?: unknown }).code;
          } else {
            throw err;
          }
        })
        .then(resolve, reject);
    if (args.noStore) run();
    else new RequestContextMiddleware().use({} as Request, {} as Response, run);
  });
  return {
    status,
    code,
    req: req as RequestExtensions & Record<string, unknown>,
    calls,
    snapshotOrg,
  };
}

const tokenFor = (grantId: string, opts: { user?: string; session?: string; exp?: number } = {}) =>
  signSupportToken(
    {
      g: grantId,
      u: opts.user ?? SUPER,
      s: opts.session ?? SESSION,
      e: opts.exp ?? Date.now() + DAY,
    },
    SECRET,
  );
const supportHeader = (token: string) => ({ [SUPPORT_TOKEN_HEADER]: token });

/** Run `fn` with a request auth snapshot for `userId` (permission helpers read it). */
function asUser<T>(
  userId: string,
  permissions: EffectivePermissions,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new RequestContextMiddleware().use({} as Request, {} as Response, () => {
      setRequestAuth({
        userId,
        systemRole: USERS[userId]?.systemRole ?? 'EMPLOYEE',
        organizationId: USERS[userId]?.organizationId ?? null,
        permissions,
      });
      fn().then(resolve, reject);
    });
  });
}

const httpStatus = (err: unknown): number | null =>
  err instanceof HttpException ? err.getStatus() : null;
const httpCode = (err: unknown): unknown =>
  err instanceof HttpException ? (err.getResponse() as { code?: unknown }).code : undefined;

async function main(): Promise<void> {
  // --- normal requests are unaffected -----------------------------------------
  {
    const db = fakePrisma();
    db.addGrant({ organizationId: ORG_B });
    const r = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: { 'x-workspace-id': WS_ROOT },
    });
    assert.equal(r.status, null, 'normal request allowed');
    assert.equal(r.req.user?.organizationId, ROOT_ORG_ID, 'normal request stays in own org');
    assert.equal(r.req.user?.systemRole, 'SUPER_ADMIN', 'normal request keeps its role');
    assert.equal(r.req.support, undefined, 'normal request has no support session');
    assert.equal(r.req.workspaceId, WS_ROOT);
    assert.deepEqual(r.calls.contextWs, [WS_ROOT], 'normal context resolution unchanged');
    assert.equal(db.calls.grantReads, 0, 'normal request never reads grants');
    assert.equal(db.audit.length, 0, 'normal request writes no audit row');

    const noService = await runGuard({
      prisma: db.prisma,
      userId: ROOT_EMPLOYEE,
      withSupportService: false,
    });
    assert.equal(noService.status, null, 'normal request works without the support service');
  }

  // --- no grant / expired / revoked: refused -------------------------------------
  {
    const db = fakePrisma();
    const none = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor('cmnogrant0000000000000000')),
    });
    assert.equal(none.status, 403, 'no grant refused');
    assert.equal(none.code, 'support-session-ended');

    const expired = db.addGrant({ organizationId: ORG_B, expiresAt: new Date(Date.now() - 1000) });
    // Even a token that claims a later expiry is refused: the grant is re-read.
    const r1 = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(expired.id)),
    });
    assert.equal(r1.status, 403, 'expired grant refused');
    assert.equal(r1.code, 'support-session-ended');
    const r2 = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(expired.id, { exp: Date.now() - 1000 })),
    });
    assert.equal(r2.code, 'support-session-ended', 'expired token refused');

    const revoked = db.addGrant({
      organizationId: ORG_B,
      revokedAt: new Date(),
      revokedById: TENANT_ADMIN,
    });
    const r3 = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(revoked.id)),
    });
    assert.equal(r3.status, 403, 'revoked grant refused');
    assert.equal(r3.code, 'support-session-ended');
    assert.equal(db.audit.length, 0, 'refused sessions run nothing and log nothing');

    // A suspended organization ends the session too.
    ORGS[ORG_C]!.isActive = false;
    const suspended = db.addGrant({ organizationId: ORG_C });
    const r4 = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(suspended.id)),
    });
    assert.equal(r4.code, 'support-session-ended', 'suspended org refused');
    ORGS[ORG_C]!.isActive = true;
  }

  // --- read allowed and logged; write refused and logged ---------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    const read = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      url: '/api/v1/projects?search=secret+text',
      headers: { ...supportHeader(tokenFor(grant.id)), 'x-workspace-id': WS_B2 },
    });
    assert.equal(read.status, null, 'read allowed');
    assert.equal(read.req.user?.organizationId, ORG_B, 'runs inside the granted org');
    assert.equal(read.snapshotOrg, ORG_B, 'request snapshot points at the granted org');
    assert.equal(read.req.user?.systemRole, 'EMPLOYEE', 'no platform role inside the org');
    assert.equal(read.req.workspaceId, WS_B2, 'requested workspace of the granted org');
    assert.deepEqual(
      read.req.workspaceMemberships,
      [
        { workspaceId: WS_B1, role: 'VIEWER' },
        { workspaceId: WS_B2, role: 'VIEWER' },
      ],
      'viewer of every workspace of the granted org',
    );
    assert.deepEqual(read.req.projectMemberships, []);
    assert.equal(read.req.support?.grantId, grant.id);
    assert.equal(read.req.support?.organizationName, 'Org B');
    assert.equal(read.calls.context, 1, 'one context lookup (role check only)');
    assert.deepEqual(read.calls.contextWs, [undefined], 'the root workspace header is not used');
    assert.deepEqual(
      db.audit,
      [
        {
          organizationId: ORG_B,
          actorUserId: SUPER,
          action: 'support.access',
          target: null,
          metadata: { method: 'GET', path: '/api/v1/projects' },
        },
      ],
      'read recorded in the granted org, no query string',
    );
    const perms = read.req.permissions!;
    assert.ok(
      !perms.company.includes('org.settings') && !perms.company.includes('users.manage'),
      'no admin keys',
    );
    assert.ok(!perms.company.includes('payroll.manage'), 'no payroll');

    const ability = abilityForRequest(read.req);
    assert.ok(ability.can('read', 'Project'), 'can read projects');
    assert.ok(ability.can('read', 'Invoice'), 'can read invoices');
    for (const action of ['create', 'update', 'delete', 'manage'] as const) {
      assert.ok(!ability.can(action, 'Project'), `cannot ${action} projects`);
      assert.ok(!ability.can(action, 'Lead'), `cannot ${action} leads`);
    }
    assert.ok(!ability.can('read', 'Payroll'), 'cannot read payroll');

    // A workspace of another org falls back to the granted org's first one.
    const foreign = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: { ...supportHeader(tokenFor(grant.id)), 'x-workspace-id': WS_ROOT },
    });
    assert.equal(foreign.req.workspaceId, WS_B1, 'foreign workspace header ignored');

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const before: number = db.audit.length;
      const write = await runGuard({
        prisma: db.prisma,
        userId: SUPER,
        method,
        url: '/api/v1/projects/abc',
        headers: supportHeader(tokenFor(grant.id)),
      });
      assert.equal(write.status, 403, `${method} refused`);
      assert.equal(write.code, 'support-read-only');
      assert.equal(write.req.user, undefined, `${method} never sets a user`);
      assert.deepEqual(
        db.audit[before]?.metadata,
        { method, path: '/api/v1/projects/abc', refused: true },
        `${method} attempt recorded`,
      );
    }
    const head = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      method: 'HEAD',
      headers: supportHeader(tokenFor(grant.id)),
    });
    assert.equal(head.status, null, 'HEAD allowed');

    // Revoke through the service: the very next request is refused.
    const service = new SupportService(db.prisma, {
      emit: async () => undefined,
    } as unknown as AuditLogService);
    await asUser(TENANT_ADMIN, { company: ['org.settings'], workspace: [] }, async () => {
      await assert.rejects(
        service.revokeGrant(TENANT_ADMIN, ORG_C, grant.id),
        (e) => httpStatus(e) === 404,
        'other org cannot revoke',
      );
    });
    await asUser(TENANT_ADMIN, { company: ['org.settings'], workspace: [] }, () =>
      service.revokeGrant(TENANT_ADMIN, ORG_B, grant.id),
    );
    const after = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
    });
    assert.equal(after.code, 'support-session-ended', 'next request after revoke refused');
  }

  // --- forged / borrowed tokens -------------------------------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    const good = tokenFor(grant.id);
    const [payload, sig] = good.split('.') as [string, string];
    const edited = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    edited['e'] = Date.now() + 365 * DAY;
    const tampered = `${Buffer.from(JSON.stringify(edited)).toString('base64url')}.${sig}`;
    const forged = signSupportToken(
      { g: grant.id, u: SUPER, s: SESSION, e: Date.now() + DAY },
      'wrong-secret',
    );
    for (const [name, token] of [
      ['tampered', tampered],
      ['forged', forged],
      ['garbage', 'not-a-token'],
      ['empty', ''],
    ] as const) {
      const r = await runGuard({ prisma: db.prisma, userId: SUPER, headers: supportHeader(token) });
      assert.equal(r.status, 403, `${name} token refused`);
      assert.equal(r.code, 'support-session-invalid', `${name} token is invalid`);
    }
    const otherSession = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      sessionId: 'session-2',
      headers: supportHeader(good),
    });
    assert.equal(
      otherSession.code,
      'support-session-invalid',
      'token bound to its sign-in session',
    );
    const otherSuper = await runGuard({
      prisma: db.prisma,
      userId: SUPER_2,
      headers: supportHeader(good),
    });
    assert.equal(otherSuper.code, 'support-session-invalid', 'token bound to its super admin');
    const repeated = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: { [SUPPORT_TOKEN_HEADER]: [good, good] },
    });
    assert.equal(repeated.code, 'support-session-invalid', 'repeated header refused');
    // Node joins a header sent twice into one comma separated string.
    const joined = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(`${good}, ${good}`),
    });
    assert.equal(
      joined.code,
      'support-session-invalid',
      'repeated header joined with a comma refused',
    );
    const noService = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(good),
      withSupportService: false,
    });
    assert.equal(noService.code, 'support-session-invalid', 'fails closed without the service');
    assert.equal(db.audit.length, 0, 'nothing logged for refused tokens');
  }

  // --- only a root super admin -----------------------------------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    for (const userId of [TENANT_ADMIN, ROOT_EMPLOYEE]) {
      const r = await runGuard({
        prisma: db.prisma,
        userId,
        headers: supportHeader(tokenFor(grant.id, { user: userId })),
      });
      assert.equal(r.status, 403, `${userId} refused`);
      assert.equal(r.code, 'support-not-allowed', `${userId} is not a platform operator`);
    }
    assert.equal(db.audit.length, 0, 'non super admins log nothing');

    const service = new SupportService(db.prisma, {
      emit: async () => undefined,
    } as unknown as AuditLogService);
    await assert.rejects(
      service.startSession(TENANT_ADMIN, SESSION, grant.id),
      (e) => httpCode(e) === 'support-not-allowed',
    );
    await assert.rejects(
      service.listActive(ROOT_EMPLOYEE),
      (e) => httpCode(e) === 'support-not-allowed',
    );

    const session = await service.startSession(SUPER, SESSION, grant.id);
    assert.equal(session.organizationId, ORG_B);
    assert.deepEqual(
      db.audit.map((a) => ({
        org: a.organizationId,
        actor: a.actorUserId,
        action: a.action,
        metadata: a.metadata,
      })),
      [
        {
          org: ORG_B,
          actor: SUPER,
          action: 'support.session_started',
          metadata: { grantId: grant.id },
        },
      ],
      'session start recorded in the granted org',
    );
    assert.equal(
      session.expiresAt.getTime(),
      grant.expiresAt.getTime(),
      'session ends with the grant',
    );
    const viaStarted = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(session.token),
    });
    assert.equal(viaStarted.status, null, 'a started session works');

    const active = await service.listActive(SUPER);
    assert.deepEqual(
      active.items.map((i) => i.grantId),
      [grant.id],
      'active grants listed',
    );
    // Two active grants for one org: "Open as support" gets the one ending last.
    const later = db.addGrant({ organizationId: ORG_B, expiresAt: new Date(Date.now() + 3 * DAY) });
    db.addGrant({ organizationId: ORG_B, expiresAt: new Date(Date.now() + 2 * HOUR) });
    assert.deepEqual(
      (await service.listActive(SUPER)).items.map((i) => i.grantId),
      [later.id],
      'one grant per org, the latest ending',
    );
    // A suspended organization's grants are not listed.
    ORGS[ORG_B]!.isActive = false;
    assert.equal((await service.listActive(SUPER)).items.length, 0, 'suspended org not listed');
    ORGS[ORG_B]!.isActive = true;
    later.revokedAt = new Date();
    db.grants.splice(db.grants.length - 1, 1);
    db.addGrant({ organizationId: ORG_B, revokedAt: new Date() });
    assert.equal((await service.listActive(SUPER)).items.length, 1, 'revoked grants not listed');
    await assert.rejects(
      service.startSession(SUPER, SESSION, 'cmnogrant0000000000000000'),
      (e) => httpCode(e) === 'support-session-ended',
      'no grant: no session',
    );
  }

  // --- a request that can't be logged is not run ---------------------------------
  {
    const db = fakePrisma({ auditFails: true });
    const grant = db.addGrant({ organizationId: ORG_B });
    const r = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
    });
    assert.equal(r.status, 503, 'unlogged request refused');
    assert.equal(r.req.user, undefined, 'unlogged request never runs');
  }

  // --- creating grants ----------------------------------------------------------------
  {
    const db = fakePrisma();
    const emitted: Array<{
      action: string;
      metadata?: Record<string, unknown>;
      organizationId: string;
    }> = [];
    const service = new SupportService(db.prisma, {
      emit: async (e: (typeof emitted)[number]) => {
        emitted.push(e);
      },
    } as unknown as AuditLogService);
    const now = new Date('2026-10-01T00:00:00.000Z');
    const admin = { company: ['org.settings'], workspace: [] };

    await asUser(TENANT_ADMIN, { company: [], workspace: [] }, async () => {
      await assert.rejects(
        service.createGrant(TENANT_ADMIN, ORG_C, { duration: '1h' }, now),
        (e) => httpStatus(e) === 403,
        'needs org.settings',
      );
      await assert.rejects(service.listGrants(TENANT_ADMIN, ORG_C), (e) => httpStatus(e) === 403);
    });

    await asUser(TENANT_ADMIN, admin, async () => {
      await assert.rejects(
        service.createGrant(
          TENANT_ADMIN,
          ORG_C,
          { expiresAt: new Date(now.getTime() + 31 * DAY) },
          now,
        ),
        (e) => httpStatus(e) === 400 && httpCode(e) === 'support-grant-too-long',
        'grant over 30 days refused',
      );
      await assert.rejects(
        service.createGrant(
          TENANT_ADMIN,
          ORG_C,
          { expiresAt: new Date(now.getTime() - 1000) },
          now,
        ),
        (e) => httpStatus(e) === 400 && httpCode(e) === 'support-grant-in-past',
        'grant in the past refused',
      );
      assert.equal(db.grants.length, 0, 'refused grants store nothing');

      const exact = await service.createGrant(
        TENANT_ADMIN,
        ORG_C,
        { expiresAt: new Date(now.getTime() + 30 * DAY) },
        now,
      );
      assert.equal(exact.status, 'ACTIVE', '30 days exactly is allowed');
      const preset = await service.createGrant(
        TENANT_ADMIN,
        ORG_C,
        { duration: '72h', reason: ' look at invoices ' },
        now,
      );
      assert.equal(preset.expiresAt.getTime(), now.getTime() + 72 * HOUR, '72h preset');
      assert.equal(preset.readOnly, true, 'always read only');
      assert.equal(preset.reason, 'look at invoices');
      assert.equal(preset.grantedBy?.id, TENANT_ADMIN, 'who granted it');

      const created = emitted.filter((e) => e.action === 'support.grant_created');
      assert.equal(created.length, 2, 'grant_created emitted per grant');
      assert.deepEqual(
        created[1]!.metadata,
        {
          expiresAt: new Date(now.getTime() + 72 * HOUR).toISOString(),
          readOnly: true,
        },
        'grant_created metadata: end time and read only flag only',
      );
      assert.equal(created[1]!.organizationId, ORG_C, 'logged in the granting org');

      const listed = await service.listGrants(TENANT_ADMIN, ORG_C, now);
      assert.equal(listed.items.length, 2, 'grants listed');

      await service.revokeGrant(TENANT_ADMIN, ORG_C, preset.id, now);
      assert.ok(
        emitted.some((e) => e.action === 'support.grant_revoked'),
        'grant_revoked emitted',
      );
      await assert.rejects(
        service.revokeGrant(TENANT_ADMIN, ORG_C, preset.id, now),
        (e) => httpStatus(e) === 409,
        'revoking twice is a conflict',
      );
    });

    assert.ok(!createSupportGrantSchema.safeParse({}).success, 'preset or end time required');
    assert.ok(
      !createSupportGrantSchema.safeParse({ duration: '1h', expiresAt: new Date().toISOString() })
        .success,
      'not both',
    );
    assert.ok(
      !createSupportGrantSchema.safeParse({ duration: '7d' }).success,
      'unknown preset refused',
    );
  }

  // --- platform log -----------------------------------------------------------------
  {
    for (const action of ['support.grant_created', 'support.grant_revoked']) {
      assert.ok(
        (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action),
        `${action} in platform log`,
      );
    }
    assert.ok(
      !(PLATFORM_AUDIT_ACTIONS as readonly string[]).includes('support.access'),
      'access rows stay in the org',
    );
    const entry: AuditLogEntry = {
      id: 'cmaudit000000000000000001',
      organizationId: ORG_B,
      actorUserId: TENANT_ADMIN,
      action: 'support.grant_created',
      target: `organization:${ORG_B}`,
      targetLabel: { type: 'organization', name: 'Org B' },
      metadata: { expiresAt: '2026-10-02T00:00:00.000Z', readOnly: true, extra: 'private' },
      labels: { [TENANT_ADMIN]: 'Alice' },
      createdAt: new Date(),
      actorUser: { id: TENANT_ADMIN, name: 'Alice', email: 'alice@example.test', image: null },
    };
    const safe = platformSafeEntry(entry);
    assert.equal(safe.actorUser, null, 'no actor');
    assert.equal(safe.actorUserId, null);
    assert.deepEqual(safe.metadata, { expiresAt: '2026-10-02T00:00:00.000Z', readOnly: true });
    assert.deepEqual(safe.labels, {});
    const other = { ...entry, action: 'org.update' };
    assert.equal(platformSafeEntry(other), other, 'other platform actions unchanged');
  }

  // --- wiring: AppModule loads SupportModule, which exports the session service ---
  {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? []) as unknown[];
    assert.ok(imports.includes(SupportModule), 'AppModule imports SupportModule');
    const exported = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SupportModule) ??
      []) as unknown[];
    assert.ok(
      exported.includes(SupportSessionService),
      'SupportModule exports SupportSessionService',
    );
  }

  // --- the request is marked as support only after its access row ---------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    let markedDuringInsert: boolean | null = null;
    const auditLog = db.prisma.client.auditLog as unknown as {
      create: (args: unknown) => Promise<unknown>;
    };
    const create = auditLog.create;
    auditLog.create = async (args: unknown) => {
      markedDuringInsert = isSupportRequest();
      return create(args);
    };
    const r = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
    });
    assert.equal(r.status, null);
    assert.equal(
      markedDuringInsert,
      false,
      'the access row is written before the backstop applies',
    );
  }

  // --- excluded areas: refused after logging ----------------------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    for (const url of [
      '/api/v1/mail/messages?folder=inbox',
      '/API/V1/Chat/rooms',
      '/api/v1/notifications',
      '/api/v1/livekit/token',
      '/api/v1/todos/abc',
      '/api/v1/%6Dail/accounts',
      '/api/v1//chat/rooms',
      // The bare prefix with a query or fragment: matched on the path alone.
      '/api/v1/chat?x=1',
      '/api/v1/mail#inbox',
      '/api/v1/notifications?st=1',
    ]) {
      const before: number = db.audit.length;
      const r = await runGuard({
        prisma: db.prisma,
        userId: SUPER,
        url,
        headers: supportHeader(tokenFor(grant.id)),
      });
      assert.equal(r.status, 403, `${url} refused`);
      assert.equal(r.code, 'support-excluded', `${url} is excluded`);
      assert.equal(r.req.user, undefined, `${url} never runs`);
      assert.equal(
        (db.audit[before]?.metadata as { refused?: boolean } | undefined)?.refused,
        true,
        `${url} logged as refused`,
      );
    }
    for (const prefix of ['/mail', '/chat', '/notifications', '/livekit', '/todos']) {
      assert.ok(SUPPORT_EXCLUDED_PREFIXES.includes(prefix), `${prefix} excluded`);
    }
    assert.ok(
      !isSupportExcludedPath('/api/v1/mailboxes', '/api/v1'),
      'a longer word is not a prefix match',
    );
    assert.ok(!isSupportExcludedPath('/api/v1/projects', 'api/v1'), 'projects allowed');
    assert.ok(
      isSupportExcludedPath('/api/v1/x', 'api/v1', 'chat/requests'),
      'controller path is checked too',
    );
    // Secret path params never reach the log.
    assert.equal(
      supportAccessPath('/api/v1/chat/invites/abc123?x=1'),
      '/api/v1/chat/invites/:code',
    );
    assert.equal(
      supportAccessPath('/api/v1/invitations/tok_1', { token: 'tok_1' }),
      '/api/v1/invitations/:token',
    );
    assert.equal(
      supportAccessPath('/api/v1/projects/cmp1', { id: 'cmp1' }),
      '/api/v1/projects/cmp1',
      'ids stay',
    );
  }

  // --- no request store: a support request fails closed ---------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    const r = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
      noStore: true,
    });
    assert.equal(r.status, 503, 'refused without a request store');
    assert.equal(r.code, 'support-log-unavailable');
    assert.equal(r.req.user, undefined, 'never runs');
    const normal = await runGuard({ prisma: db.prisma, userId: SUPER, noStore: true });
    assert.equal(normal.status, null, 'normal request without a store unchanged');
  }

  // --- a request refused later (403) is marked refused --------------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    const r = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
      response,
    });
    assert.equal(r.status, null);
    assert.deepEqual(db.audit[0]?.metadata, { method: 'GET', path: '/api/v1/projects' });
    response.statusCode = 403;
    response.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      db.audit[0]?.metadata,
      { method: 'GET', path: '/api/v1/projects', refused: true },
      'marked refused',
    );

    const ok = Object.assign(new EventEmitter(), { statusCode: 200 });
    await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      headers: supportHeader(tokenFor(grant.id)),
      response: ok,
    });
    ok.emit('finish');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      db.audit[1]?.metadata,
      { method: 'GET', path: '/api/v1/projects' },
      'a 200 stays unmarked',
    );
  }

  // --- token in the query string only on marked routes -------------------------------
  {
    const db = fakePrisma();
    const grant = db.addGrant({ organizationId: ORG_B });
    const token = tokenFor(grant.id);
    const marked = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      url: `/api/v1/files/cmfile/content?st=${token}`,
      query: { st: token },
      handler: Handler.prototype.content,
    });
    assert.ok(marked.req.support, 'marked route takes the support branch from ?st=');
    assert.deepEqual(
      db.audit.at(-1)?.metadata,
      { method: 'GET', path: '/api/v1/files/cmfile/content' },
      'token never logged',
    );
    const unmarked = await runGuard({ prisma: db.prisma, userId: SUPER, query: { st: token } });
    assert.equal(unmarked.req.support, undefined, 'other routes ignore ?st=');
    const repeated = await runGuard({
      prisma: db.prisma,
      userId: SUPER,
      query: { st: [token, token] },
      handler: Handler.prototype.content,
    });
    assert.equal(repeated.code, 'support-session-invalid', 'repeated ?st= refused');
  }

  // --- write backstop ----------------------------------------------------------------
  {
    await asSupport(async () => {
      for (const action of [
        'create',
        'createMany',
        'update',
        'updateMany',
        'upsert',
        'delete',
        'deleteMany',
        'executeRaw',
      ]) {
        assert.throws(
          () => assertSupportWriteAllowed(action),
          (e) => httpCode(e) === 'support-read-only',
          `${action} refused`,
        );
      }
      for (const action of ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy', 'queryRaw']) {
        assert.doesNotThrow(() => assertSupportWriteAllowed(action), `${action} allowed`);
      }
    });
    assert.doesNotThrow(() => assertSupportWriteAllowed('create'), 'normal requests unaffected');

    // The real middleware on the real clients (refused before any database call).
    new AuthContextCache({ client: { status: 'end' } } as unknown as RedisService).onModuleInit();
    await asSupport(async () => {
      await assert.rejects(
        rawPrisma.auditLog.create({ data: { organizationId: ORG_B, action: 'x' } }),
        (e) => httpCode(e) === 'support-read-only',
        'base client write refused',
      );
      await assert.rejects(
        extendedPrisma.project.updateMany({ where: { id: 'x' }, data: { name: 'y' } }),
        (e) => httpCode(e) === 'support-read-only',
        'soft delete extended client write refused',
      );
      await assert.rejects(
        extendedPrisma.project.delete({ where: { id: 'x' } }),
        (e) => httpCode(e) === 'support-read-only',
        'soft delete (rewritten to update) refused',
      );
      await assert.rejects(
        rawPrisma.$executeRawUnsafe('UPDATE "Project" SET "name" = $1', 'y'),
        (e) => httpCode(e) === 'support-read-only',
        'raw statement refused',
      );
    });
  }

  // --- permission fallbacks stay in the support session --------------------------------
  {
    await asSupport(async () => {
      // No database: a fallback to the operator's own rows would throw here.
      const inGranted = await loadEffectivePermissions(SUPER, WS_B1);
      assert.deepEqual(inGranted.company, [...SUPPORT_SESSION_PERMISSIONS.company]);
      assert.deepEqual(inGranted.workspace, [...SUPPORT_SESSION_PERMISSIONS.workspace]);
      const elsewhere = await loadEffectivePermissions(SUPER, WS_ROOT);
      assert.deepEqual(elsewhere.workspace, [], 'no workspace keys outside the granted org');
      clearRequestAuth();
      assert.equal(
        requestAuthFor(SUPER)?.organizationId,
        ORG_B,
        'support snapshot survives clearRequestAuth',
      );
    });
  }

  // --- payroll stays out of expenses -----------------------------------------------------
  {
    const seen: Array<Record<string, unknown>> = [];
    const fake = {
      client: {
        expense: {
          findMany: async (args: { where: Record<string, unknown> }) => {
            seen.push(args.where);
            return [];
          },
          count: async () => 0,
        },
      },
    } as unknown as PrismaService;
    const service = new ExpensesService(fake, {} as RedisService);
    const scope = { userId: SUPER, currentWorkspaceId: WS_B1 } as unknown as UserScope;
    await asSupport(async () => {
      await service.list(scope, listExpensesQuerySchema.parse({}));
      assert.deepEqual(seen.at(-1)?.['category'], { not: 'SALARY' }, 'salaries left out');
      const before = seen.length;
      const salary = await service.list(
        scope,
        listExpensesQuerySchema.parse({ category: 'SALARY' }),
      );
      assert.equal(salary.items.length, 0, 'a salary filter matches nothing');
      assert.equal(seen.length, before, 'without a query');
      await service.list(scope, listExpensesQuerySchema.parse({ category: 'TAX' }));
      assert.equal(seen.at(-1)?.['category'], 'TAX', 'other categories as asked');
      assert.deepEqual(
        generalFileVisibility(true).expenseReceipts,
        { none: { category: 'SALARY' } },
        'no salary receipts',
      );
    });
    await service.list(scope, listExpensesQuerySchema.parse({}));
    assert.equal(seen.at(-1)?.['category'], undefined, 'normal requests unchanged');
    assert.equal(
      generalFileVisibility(true).expenseReceipts,
      undefined,
      'normal file visibility unchanged',
    );
  }

  // --- search leaves chat and mail out ---------------------------------------------------
  {
    const search = new SearchService({} as PrismaService) as unknown as {
      applies(kind: string, ctx: Record<string, unknown>): boolean;
    };
    const ctx = { match: { words: ['x'] } };
    await asSupport(async () => {
      for (const kind of ['chat_message', 'chat_room', 'file', 'mail']) {
        assert.equal(search.applies(kind, ctx), false, `${kind} not searched`);
      }
      assert.equal(search.applies('project', ctx), true, 'projects searched');
    });
    assert.equal(search.applies('mail', ctx), true, 'normal search unchanged');
  }

  // --- global admin routes refuse support sessions ------------------------------------
  {
    let asserted = 0;
    const guard = new GlobalAdminGuard(new Reflector(), {
      assertGlobalAdmin: async () => {
        asserted++;
      },
    } as never);
    const ctxFor = (req: Record<string, unknown>) =>
      ({
        getHandler: () => AdminHandler.prototype.handle,
        getClass: () => AdminHandler,
        switchToHttp: () => ({ getRequest: () => req }),
      }) as unknown as ExecutionContext;
    await assert.rejects(
      guard.canActivate(ctxFor({ user: { id: SUPER }, support: { grantId: 'g' } })),
      (e) => httpCode(e) === 'support-not-allowed',
      'support session refused on a global admin route',
    );
    await asSupport(() =>
      assert.rejects(
        guard.canActivate(ctxFor({ user: { id: SUPER } })),
        (e) => httpCode(e) === 'support-not-allowed',
        'support request store refused too',
      ),
    );
    assert.equal(asserted, 0, 'the database role is never consulted');
    assert.equal(await guard.canActivate(ctxFor({ user: { id: SUPER } })), true);
    assert.equal(asserted, 1, 'normal requests unchanged');
  }

  // --- file links point at the guarded content route -------------------------------------
  {
    process.env.S3_PUBLIC_URL = 'https://files.example.test';
    process.env.S3_PUBLIC_URL_INCLUDES_BUCKET = 'true';
    process.env.S3_BUCKET = 'botss-files';
    process.env.BETTER_AUTH_URL = 'https://api.example.test';
    const files = new FilesService({} as PrismaService);
    const pattern = files.fileUrlPattern();
    assert.ok(pattern, 'file link pattern');
    const known = `workspaces/${WS_B1}/abc_1-photo.png`;
    const url = `https://files.example.test/botss-files/${known}`;
    const body = {
      when: new Date(0),
      items: [{ id: 'cmfile000000000000000001', url }],
      html: `<p><img src="${url}"></p>`,
      other: 'https://files.example.test/botss-files/workspaces/zzz/legacy%20name.pdf',
      unrelated: 'https://example.test/page',
    };
    const found = collectFileLinkKeys(body, pattern);
    assert.ok(found.found);
    assert.deepEqual([...found.keys], [known]);
    const copy = rewriteFileLinks(body, pattern, (key) => (key ? `LINK(${key})` : 'NONE'));
    assert.equal(copy.items[0]?.url, `LINK(${known})`);
    assert.equal(copy.html, `<p><img src="LINK(${known})"></p>`);
    assert.equal(copy.unrelated, body.unrelated, 'other links untouched');
    assert.ok(copy.when instanceof Date, 'dates kept');
    assert.equal(body.items[0]?.url, url, 'the original is never mutated');

    let lookupWhere: unknown = null;
    const interceptor = new SupportFileLinksInterceptor(
      {
        client: {
          fileObject: {
            findMany: async (args: { where: unknown }) => {
              lookupWhere = args.where;
              return [{ id: 'cmfile000000000000000001', objectKey: known }];
            },
          },
        },
      } as unknown as PrismaService,
      files,
    );
    const httpCtx = (req: Record<string, unknown>) =>
      ({
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      }) as unknown as ExecutionContext;
    const supportReq = {
      support: { grantId: 'g' },
      supportToken: 'tok.en',
      workspaceMemberships: [{ workspaceId: WS_B1, role: 'VIEWER' }],
    };
    const out = (await lastValueFrom(
      interceptor.intercept(httpCtx(supportReq), { handle: () => of(body) }),
    )) as typeof body;
    assert.equal(
      out.items[0]?.url,
      'https://api.example.test/api/v1/files/cmfile000000000000000001/content?st=tok.en',
      'known file links to the content route',
    );
    assert.equal(
      out.other,
      'https://api.example.test/api/v1/files/unavailable/content',
      'unknown file never shows its public URL',
    );
    assert.deepEqual(
      lookupWhere,
      { objectKey: { in: [known] }, workspaceId: { in: [WS_B1] } },
      'granted workspaces only',
    );
    const normal = await lastValueFrom(
      interceptor.intercept(httpCtx({}), { handle: () => of(body) }),
    );
    assert.equal(normal, body, 'normal responses untouched');
  }

  // --- chat attachments stay hidden from support in /files ------------------------------
  {
    const CHAT_FILE = 'cmfilechat00000000000000a';
    const PLAIN_FILE = 'cmfileplain0000000000000a';
    const chatUrl = 'https://files.example.test/botss-files/workspaces/b1/chat.png';
    const rows: Record<string, { id: string; url: string; workspaceId: string }> = {
      [CHAT_FILE]: { id: CHAT_FILE, url: chatUrl, workspaceId: WS_B1 },
      [PLAIN_FILE]: {
        id: PLAIN_FILE,
        url: 'https://files.example.test/botss-files/workspaces/b1/doc.pdf',
        workspaceId: WS_B1,
      },
    };
    const seen = { raw: 0, listWhere: null as unknown, s3: 0 };
    const fake = {
      client: {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          seen.raw++;
          assert.ok(strings.join('?').includes('"ChatAttachment"'), 'joins ChatAttachment');
          assert.deepEqual(values, [WS_B1], 'scoped to the workspace');
          return [{ id: CHAT_FILE }];
        },
        chatAttachment: {
          findFirst: async (args: { where: { fileUrl: string } }) =>
            args.where.fileUrl === chatUrl ? { id: 'cmatt' } : null,
        },
        fileObject: {
          findMany: async (args: { where: unknown }) => {
            seen.listWhere = args.where;
            return [];
          },
          count: async () => 0,
          findFirst: async (args: { where: { id: string } }) => {
            const row = rows[args.where.id];
            return row
              ? {
                  ...row,
                  bucket: 'b',
                  objectKey: 'k',
                  mimeType: 'image/png',
                  filename: 'f.png',
                  sizeBytes: 1n,
                }
              : null;
          },
        },
      },
    } as unknown as PrismaService;
    const service = new FilesService(fake);
    (service as unknown as { s3: { send: () => Promise<unknown> } }).s3 = {
      send: async () => {
        seen.s3++;
        return { Body: { pipe() {} }, ContentLength: 1 };
      },
    };
    const q = { page: 1, pageSize: 20, sort: 'createdAt', order: 'desc' } as never;
    await asSupport(async () => {
      await service.list(WS_B1, q, { financeAccess: false });
      assert.deepEqual(
        (seen.listWhere as { id?: unknown }).id,
        { notIn: [CHAT_FILE] },
        'chat files left out of the list',
      );
      await assert.rejects(
        service.get(WS_B1, CHAT_FILE, { financeAccess: false }),
        (e) => httpStatus(e) === 404,
        'chat file 404',
      );
      assert.equal(
        (await service.get(WS_B1, PLAIN_FILE, { financeAccess: false })).id,
        PLAIN_FILE,
        'other files open',
      );
      await assert.rejects(
        service.openContent([WS_B1], CHAT_FILE, { financeAccess: false }),
        (e) => httpStatus(e) === 404,
        'chat file content 404',
      );
      assert.equal(seen.s3, 0, 'never read from storage');
      await service.openContent([WS_B1], PLAIN_FILE, { financeAccess: false });
      assert.equal(seen.s3, 1, 'other content opens');
    });
    const rawBefore = seen.raw;
    await service.list(WS_B1, q, { financeAccess: false });
    assert.equal((seen.listWhere as { id?: unknown }).id, undefined, 'normal list unchanged');
    assert.equal(seen.raw, rawBefore, 'no chat lookup for normal requests');
    assert.equal(
      (await service.get(WS_B1, CHAT_FILE, { financeAccess: false })).id,
      CHAT_FILE,
      'normal get unchanged',
    );
    await service.openContent([WS_B1], CHAT_FILE, { financeAccess: false });
    assert.equal(seen.s3, 2, 'normal content unchanged');
  }

  // --- content route: workspace scope and served type ------------------------------------
  {
    const memberships = [
      { workspaceId: WS_B1, role: 'VIEWER' },
      { workspaceId: WS_B2, role: 'VIEWER' },
    ];
    assert.deepEqual(
      contentWorkspaceIds({
        support: { grantId: 'g' } as never,
        workspaceId: WS_B1,
        workspaceMemberships: memberships,
      }),
      [WS_B1, WS_B2],
      'support reads its granted workspaces',
    );
    assert.deepEqual(
      contentWorkspaceIds({ workspaceId: WS_B1, workspaceMemberships: memberships }),
      [WS_B1],
      'a normal user only the active workspace',
    );
    assert.deepEqual(
      contentWorkspaceIds({ workspaceId: null, workspaceMemberships: memberships }),
      [],
      'no active workspace',
    );

    assert.equal(inlineContentType('image/png'), 'image/png');
    assert.equal(inlineContentType(' Video/MP4 '), 'video/mp4', 'normalized');
    assert.equal(inlineContentType('audio/webm'), 'audio/webm');
    assert.equal(inlineContentType('application/pdf'), 'application/pdf');
    for (const hostile of [
      'video/mp4\r\nSet-Cookie: a=b',
      'audio/ogg; codecs=opus',
      'video/',
      'audio/x"y',
      `video/${'a'.repeat(200)}`,
      'image/svg+xml',
      'text/html',
      '',
    ]) {
      assert.equal(inlineContentType(hostile), null, `${JSON.stringify(hostile)} is a download`);
    }
  }

  // --- errors never echo or log the query string -----------------------------------------
  {
    const filter = new ProblemDetailsExceptionFilter();
    const sent: Array<{ instance?: string }> = [];
    const logged: string[] = [];
    (filter as unknown as { logger: { error: (m: string) => void } }).logger = {
      error: (m) => logged.push(m),
    };
    const res = {
      status: () => res,
      type: () => res,
      json: (b: { instance?: string }) => {
        sent.push(b);
        return res;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({
          method: 'GET',
          originalUrl: '/api/v1/files/cmf/content?st=secret.token#x',
        }),
      }),
    } as never;
    filter.catch(new HttpException({ title: 'Nope', status: 403 }, 403), host);
    filter.catch(new Error('boom'), host);
    assert.equal(sent.length, 2);
    for (const b of sent)
      assert.equal(b.instance, '/api/v1/files/cmf/content', 'instance has no query');
    assert.ok(
      logged.length > 0 && logged.every((m) => !m.includes('secret.token')),
      'token never logged',
    );
  }

  // --- platform log: support events never match on their actor -------------------------
  {
    const wheres: unknown[] = [];
    const models: Record<string, unknown> = {
      user: { findUnique: async () => ({ systemRole: 'SUPER_ADMIN' }), findMany: async () => [] },
      auditLog: {
        findMany: async (args: { where: unknown }) => {
          wheres.push(args.where);
          return [];
        },
        count: async () => 0,
      },
    };
    const client = new Proxy(models, {
      get: (target, key: string) => target[key] ?? { findMany: async () => [] },
    });
    const service = new AuditLogService({ client } as unknown as PrismaService);
    // The platform log never filters or searches by actor (support grants and
    // security alerts are about people of other organizations).
    await service.listPlatform(SUPER, listAuditLogQuerySchema.parse({ actorUserId: TENANT_ADMIN }));
    const byActor = JSON.stringify(wheres.at(-1));
    assert.ok(!byActor.includes('actorUserId'), 'an actor filter is ignored on the platform log');
    await service.listPlatform(SUPER, listAuditLogQuerySchema.parse({ search: 'alice' }));
    const bySearch = JSON.stringify(wheres.at(-1));
    assert.ok(!bySearch.includes('actorUser'), 'free text never matches the actor');
    assert.ok(bySearch.includes('alice'), 'free text still matches action and target');
  }

  console.log('check-support-access: OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
