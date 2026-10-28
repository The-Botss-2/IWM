/**
 * Auth context self-checks that need no database or Redis:
 *
 * 1. `buildAuthContext` reproduces the old three-helper resolution
 *    (getUserOrgContext + getSessionContext + loadEffectivePermissions):
 *    tenant wall, deleted workspaces, requested vs default workspace,
 *    override scoping and custom-role liveness.
 * 2. `isAuthContextWrite` flags exactly the writes that can change a
 *    cached context.
 * 3. `AuthContextCache` serves a hit, voids it on invalidation, refuses to
 *    write without an epoch, and falls through when Redis is not ready.
 * 4. The per-request snapshot only answers for its own user.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import { resolveCompanyPermissions, resolveWorkspacePermissions } from '@botss/auth';

import { AuthContextCache, isAuthContextWrite } from '../auth/auth-context-cache';
import { type AuthContextRows, buildAuthContext } from '../auth/auth-context';
import {
  RequestContextMiddleware,
  clearRequestAuth,
  requestAuthFor,
  setRequestAuth,
} from '../common/request-context';
import type { RedisService } from '../redis/redis.service';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function rows(overrides: Partial<AuthContextRows> = {}): AuthContextRows {
  return {
    user: {
      systemRole: 'EMPLOYEE',
      organizationId: 'org1',
      accountType: 'STAFF',
      deleted: false,
      organization: { deleted: false, isActive: true },
      customRole: null,
    },
    workspaceMemberships: [
      {
        workspaceId: 'wA',
        role: 'MEMBER',
        workspaceOrganizationId: 'org1',
        workspaceDeleted: false,
        customRole: null,
      },
      {
        workspaceId: 'wB',
        role: 'ADMIN',
        workspaceOrganizationId: 'org1',
        workspaceDeleted: false,
        customRole: null,
      },
      // Deleted workspace and a cross-org row: both must be dropped.
      {
        workspaceId: 'wDel',
        role: 'OWNER',
        workspaceOrganizationId: 'org1',
        workspaceDeleted: true,
        customRole: null,
      },
      {
        workspaceId: 'wX',
        role: 'OWNER',
        workspaceOrganizationId: 'org2',
        workspaceDeleted: false,
        customRole: null,
      },
    ],
    projectMemberships: [
      {
        projectId: 'p1',
        role: 'CONTRIBUTOR',
        abilities: { a: 1 },
        projectWorkspaceId: 'wA',
        workspaceOrganizationId: 'org1',
      },
      {
        projectId: 'p2',
        role: 'VIEWER',
        abilities: null,
        projectWorkspaceId: 'wX',
        workspaceOrganizationId: 'org2',
      },
    ],
    overrides: [
      { permission: 'hr.attendance', grant: true, workspaceId: null },
      { permission: 'projects.manage', grant: false, workspaceId: 'wB' },
      { permission: 'projects.manage', grant: true, workspaceId: 'wA' },
    ],
    ...overrides,
  };
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. buildAuthContext
  // -------------------------------------------------------------------------
  {
    const ctx = buildAuthContext(rows());
    check(
      'ctx: default workspace is the first live membership',
      ctx.session.currentWorkspaceId === 'wA',
    );
    check(
      'ctx: deleted and cross-org workspaces dropped',
      same(ctx.session.workspaceMemberships, [
        { workspaceId: 'wA', role: 'MEMBER' },
        { workspaceId: 'wB', role: 'ADMIN' },
      ]),
      JSON.stringify(ctx.session.workspaceMemberships),
    );
    check(
      'ctx: cross-org project membership dropped',
      same(ctx.session.projectMemberships, [
        { projectId: 'p1', workspaceId: 'wA', role: 'CONTRIBUTOR', abilities: { a: 1 } },
      ]),
    );
    check(
      'ctx: extras',
      same(ctx.extras, {
        systemRole: 'EMPLOYEE',
        organizationId: 'org1',
        accountType: 'STAFF',
        orgInactive: false,
        userDisabled: false,
      }),
    );
    // Same inputs the old loadEffectivePermissions(userId, 'wA') passed.
    const ov = rows().overrides.filter((o) => o.workspaceId === null || o.workspaceId === 'wA');
    check(
      'ctx: permissions match the old resolution',
      same(ctx.permissions, {
        company: resolveCompanyPermissions({
          systemRole: 'EMPLOYEE',
          customRolePermissions: null,
          overrides: ov,
        }),
        workspace: resolveWorkspacePermissions({
          role: 'MEMBER',
          customRolePermissions: null,
          overrides: ov,
          workspaceId: 'wA',
        }),
      }),
    );
  }
  {
    const ctx = buildAuthContext(rows(), 'wB');
    check('ctx: requested member workspace wins', ctx.session.currentWorkspaceId === 'wB');
    const ov = rows().overrides.filter((o) => o.workspaceId === null || o.workspaceId === 'wB');
    check(
      'ctx: workspace permissions follow the requested workspace',
      same(
        ctx.permissions.workspace,
        resolveWorkspacePermissions({
          role: 'ADMIN',
          customRolePermissions: null,
          overrides: ov,
          workspaceId: 'wB',
        }),
      ),
    );
  }
  {
    check(
      'ctx: non-member workspace header ignored',
      buildAuthContext(rows(), 'wX').session.currentWorkspaceId === 'wA',
    );
    check(
      'ctx: deleted workspace header ignored',
      buildAuthContext(rows(), 'wDel').session.currentWorkspaceId === 'wA',
    );
  }
  {
    const ctx = buildAuthContext(rows({ user: null }));
    check(
      'ctx: missing user is disabled',
      ctx.extras.userDisabled === true && ctx.extras.accountType === 'STAFF',
    );
    check(
      'ctx: missing user has no permissions',
      same(ctx.permissions, { company: [], workspace: [] }),
    );
  }
  {
    const r = rows();
    r.user!.deleted = true;
    check('ctx: soft-deleted user disabled', buildAuthContext(r).extras.userDisabled === true);
    const s = rows();
    s.user!.organization = { deleted: false, isActive: false };
    check('ctx: suspended org flagged', buildAuthContext(s).extras.orgInactive === true);
    const t = rows();
    t.user!.organization = { deleted: true, isActive: true };
    check('ctx: archived org flagged', buildAuthContext(t).extras.orgInactive === true);
  }
  {
    // An org-less (legacy) user keeps every live membership.
    const r = rows();
    r.user!.organizationId = null;
    const ctx = buildAuthContext(r);
    check('ctx: org-less user keeps cross-org rows', ctx.session.workspaceMemberships.length === 3);
    check(
      'ctx: org-less user keeps cross-org projects',
      ctx.session.projectMemberships.length === 2,
    );
  }
  {
    // Custom roles count only while live, of the right scope, in the user's org.
    const live = {
      permissions: ['x.custom'],
      deleted: false,
      scope: 'COMPANY',
      organizationId: 'org1',
    };
    const variants: Array<[string, typeof live, boolean]> = [
      ['live', live, true],
      ['deleted', { ...live, deleted: true }, false],
      ['wrong scope', { ...live, scope: 'WORKSPACE' }, false],
      ['other org', { ...live, organizationId: 'org2' }, false],
    ];
    for (const [name, role, used] of variants) {
      const r = rows({ overrides: [] });
      r.user!.customRole = role;
      const company = buildAuthContext(r).permissions.company;
      check(
        `ctx: company custom role ${name}`,
        company.includes('x.custom') === used,
        JSON.stringify(company),
      );
    }
    const r = rows({ overrides: [] });
    r.workspaceMemberships[0]!.customRole = {
      ...live,
      scope: 'WORKSPACE',
      permissions: ['y.custom'],
    };
    check(
      'ctx: workspace custom role applies to the active workspace',
      buildAuthContext(r).permissions.workspace.includes('y.custom'),
    );
    check(
      'ctx: workspace custom role ignored for another workspace',
      !buildAuthContext(r, 'wB').permissions.workspace.includes('y.custom'),
    );
  }
  {
    const ctx = buildAuthContext(rows({ workspaceMemberships: [] }));
    check(
      'ctx: no memberships → null workspace, empty workspace perms',
      ctx.session.currentWorkspaceId === null && ctx.permissions.workspace.length === 0,
    );
  }
  {
    // The cache stores JSON: a round-trip must not change the answer.
    const r = rows();
    check(
      'ctx: JSON round-trip is lossless',
      same(buildAuthContext(JSON.parse(JSON.stringify(r)), 'wB'), buildAuthContext(r, 'wB')),
    );
  }

  // -------------------------------------------------------------------------
  // 2. Invalidation rules
  // -------------------------------------------------------------------------
  const yes: Array<[string, string, unknown]> = [
    ['WorkspaceMembership', 'create', { data: {} }],
    ['WorkspaceMembership', 'update', { data: { role: 'ADMIN' } }],
    ['WorkspaceMembership', 'delete', {}],
    ['ProjectMembership', 'deleteMany', {}],
    ['UserPermissionOverride', 'createMany', { data: [] }],
    ['Role', 'update', { data: { permissions: [] } }],
    ['User', 'update', { data: { systemRole: 'ADMIN' } }],
    ['User', 'update', { data: { deletedAt: new Date() } }],
    ['User', 'updateMany', { data: { customRoleId: null } }],
    ['User', 'delete', {}],
    ['User', 'upsert', { create: {}, update: { organizationId: 'o' } }],
    ['Organization', 'update', { data: { isActive: false } }],
    ['Workspace', 'update', { data: { deletedAt: new Date() } }],
    ['Workspace', 'deleteMany', {}],
    ['Project', 'update', { data: { workspaceId: 'w' } }],
    ['Project', 'delete', {}],
  ];
  for (const [m, a, args] of yes) check(`invalidate: ${m}.${a}`, isAuthContextWrite(m, a, args));
  const no: Array<[string | undefined, string, unknown]> = [
    ['User', 'update', { data: { name: 'x', image: null } }],
    ['User', 'create', { data: { systemRole: 'ADMIN' } }],
    ['Organization', 'update', { data: { name: 'x' } }],
    ['Project', 'update', { data: { name: 'x', deletedAt: new Date() } }],
    ['Task', 'update', { data: { status: 'DONE' } }],
    ['WorkspaceMembership', 'findMany', {}],
    ['User', 'findUnique', {}],
    [undefined, 'executeRaw', {}],
  ];
  for (const [m, a, args] of no) check(`no invalidate: ${m}.${a}`, !isAuthContextWrite(m, a, args));

  // -------------------------------------------------------------------------
  // 3. The Redis cache, against a fake client
  // -------------------------------------------------------------------------
  const store = new Map<string, string>();
  const fake = {
    status: 'ready',
    async mget(...keys: string[]) {
      return keys.map((k) => store.get(k) ?? null);
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK';
    },
    async incr(k: string) {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    },
  };
  const cache = new AuthContextCache({ client: fake } as unknown as RedisService);
  {
    const miss = await cache.get('u1');
    check('cache: cold miss', miss.rows === null && miss.epoch === '0');
    await cache.set('u1', miss.epoch, rows());
    const hit = await cache.get('u1');
    check('cache: hit after set', same(hit.rows, rows()));
    await cache.invalidateAll();
    check('cache: invalidation voids the entry', (await cache.get('u1')).rows === null);
    // A load that started before an invalidation must not be served after it.
    const before = await cache.get('u2');
    await cache.invalidateAll();
    await cache.set('u2', before.epoch, rows());
    check(
      'cache: entry written with a stale epoch is ignored',
      (await cache.get('u2')).rows === null,
    );
    await cache.set('u3', null, rows());
    check('cache: no epoch, no write', !store.has('authctx:v1:u3'));
    fake.status = 'reconnecting';
    const down = await cache.get('u1');
    check('cache: not-ready Redis falls through', down.rows === null && down.epoch === null);
    fake.status = 'ready';
  }

  // -------------------------------------------------------------------------
  // 4. Per-request snapshot
  // -------------------------------------------------------------------------
  check('snapshot: none outside a request', requestAuthFor('u1') === null);
  await new Promise<void>((resolve) => {
    new RequestContextMiddleware().use({} as never, {} as never, () => {
      setRequestAuth({
        userId: 'u1',
        systemRole: 'HR',
        organizationId: 'org1',
        permissions: { company: ['a'], workspace: [] },
      });
      void (async () => {
        await Promise.resolve();
        check('snapshot: visible across awaits', requestAuthFor('u1')?.systemRole === 'HR');
        check('snapshot: other users fall back', requestAuthFor('u2') === null);
        clearRequestAuth();
        check('snapshot: cleared after an auth write', requestAuthFor('u1') === null);
        resolve();
      })();
    });
  });

  if (failures > 0) {
    console.error(`\n${failures} auth context check(s) failed.`);
    process.exit(1);
  }
  console.log('auth context checks passed.');
}

void main();
