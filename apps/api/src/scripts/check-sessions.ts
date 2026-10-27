/**
 * Devices page (users/me/sessions) and admin "sign out everywhere"
 * self-checks, with a fake Prisma and no database:
 *  - list returns only the caller's own, unexpired sessions and flags the
 *    current one
 *  - deleting another user's session -> 404 and nothing is deleted
 *  - sign-out-others keeps the current session and never touches other users
 *  - the admin action is refused for a user in another organization (even
 *    for SUPER_ADMIN) and deletes nothing; same-org succeeds and is audited
 *    as `user.sessions_revoked`
 *  - the user-agent parser
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import { ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { AdminUsersService } from '../admin/admin-users.service';
import type { AuditLogService } from '../audit-log/audit-log.service';
import type { RealtimeEventsService } from '../notifications/realtime-events.service';
import type { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { parseUserAgent } from '../sessions/user-agent';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
}

interface FakeSession {
  id: string;
  userId: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

interface FakeUser {
  id: string;
  organizationId: string | null;
  systemRole: string;
  accountType: string;
}

const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);
const NOW = new Date();

function session(id: string, userId: string, over: Partial<FakeSession> = {}): FakeSession {
  return {
    id,
    userId,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
    ipAddress: '10.0.0.1',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: FUTURE,
    ...over,
  };
}

type Where = {
  id?: string | { not: string } | { in: string[] };
  userId?: string;
  expiresAt?: { gt: Date };
};

function matches(row: FakeSession, where: Where): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (where.id && typeof where.id === 'object') {
    if ('not' in where.id && row.id === where.id.not) return false;
    if ('in' in where.id && !where.id.in.includes(row.id)) return false;
  }
  if (where.expiresAt && !(row.expiresAt > where.expiresAt.gt)) return false;
  return true;
}

function makePrisma(sessions: FakeSession[], users: FakeUser[]) {
  const deleteCalls: Where[] = [];
  const client: Record<string, unknown> = {
    session: {
      findMany: async ({ where }: { where: Where }) => sessions.filter((s) => matches(s, where)),
      deleteMany: async ({ where }: { where: Where }) => {
        deleteCalls.push(where);
        const doomed = sessions.filter((s) => matches(s, where));
        for (const d of doomed) sessions.splice(sessions.indexOf(d), 1);
        return { count: doomed.length };
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
    },
  };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  return { prisma: { client } as unknown as PrismaService, sessions, deleteCalls };
}

async function rejects(p: Promise<unknown>, type: new (...a: never[]) => Error): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (err) {
    return err instanceof type;
  }
}

async function main(): Promise<void> {
  // ---- user-agent parser ----
  const ua = (s: string) => parseUserAgent(s);
  const win = ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36');
  check('ua windows chrome', win.os === 'Windows' && win.browser === 'Chrome' && win.device === 'Windows PC');
  const edge = ua('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0');
  check('ua edge not chrome', edge.browser === 'Edge');
  const iphone = ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
  check('ua iphone safari', iphone.os === 'iOS' && iphone.device === 'iPhone' && iphone.browser === 'Safari');
  const android = ua('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36');
  check('ua android phone', android.os === 'Android' && android.device === 'Android phone');
  const mac = ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/121.0');
  check('ua mac firefox', mac.os === 'macOS' && mac.browser === 'Firefox' && mac.device === 'Mac');
  const electron = ua('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Electron/30.0 Safari/537.36');
  check('ua electron desktop app', electron.browser === 'Desktop app');
  const webview = ua('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 Version/4.0 Chrome/120.0 Mobile Safari/537.36');
  check('ua android webview is App', webview.browser === 'App' && webview.os === 'Android', webview.browser);
  const linux = ua('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
  check('ua linux', linux.os === 'Linux');
  check('ua empty', parseUserAgent('').browser === 'Unknown' && parseUserAgent(null).os === 'Unknown');

  // ---- list returns only mine ----
  {
    const { prisma } = makePrisma(
      [
        session('s_me_1', 'me'),
        session('s_me_2', 'me', { updatedAt: new Date(NOW.getTime() - 1000) }),
        session('s_me_old', 'me', { expiresAt: PAST }),
        session('s_other', 'other'),
      ],
      [],
    );
    const svc = new SessionsService(prisma);
    const items = await svc.listMine('me', 's_me_1');
    const ids = items.map((i) => i.id).sort();
    check('list only mine, unexpired', ids.join(',') === 's_me_1,s_me_2', ids.join(','));
    check('list flags current', items.find((i) => i.id === 's_me_1')?.current === true);
    check('list others not current', items.find((i) => i.id === 's_me_2')?.current === false);
    check('list never exposes token', !items.some((i) => 'token' in i));
  }

  // ---- delete another user's session -> 404, nothing deleted ----
  {
    const { prisma, sessions } = makePrisma([session('s_me', 'me'), session('s_other', 'other')], []);
    const svc = new SessionsService(prisma);
    check('delete foreign session 404', await rejects(svc.revokeMine('me', 's_other'), NotFoundException));
    check('foreign session kept', sessions.some((s) => s.id === 's_other'));
    check('delete missing session 404', await rejects(svc.revokeMine('me', 's_nope'), NotFoundException));
    const n = await svc.revokeMine('me', 's_me');
    check('delete own session', n.join() === 's_me' && !sessions.some((s) => s.id === 's_me'));
  }

  // ---- sign out others keeps current, never touches other users ----
  {
    const { prisma, sessions, deleteCalls } = makePrisma(
      [session('a', 'me'), session('b', 'me'), session('c', 'me'), session('x', 'other')],
      [],
    );
    const svc = new SessionsService(prisma);
    const n = await svc.revokeOthers('me', 'b');
    const left = sessions.map((s) => s.id).sort().join(',');
    check('revoke others returns deleted ids', n.slice().sort().join() === 'a,c', n.join());
    check(
      'revoke others without current session refused',
      await rejects(svc.revokeOthers('me', undefined), UnauthorizedException),
    );
    check('refused revoke deleted nothing', sessions.map((x) => x.id).sort().join() === 'b,x');
    check('revoke others keeps current + other users', left === 'b,x', left);
    check('revoke others scoped to caller', deleteCalls.every((w) => w.userId === 'me'));
  }

  // ---- admin sign out everywhere ----
  {
    const users: FakeUser[] = [
      { id: 'admin', organizationId: 'orgA', systemRole: 'ADMIN', accountType: 'STAFF' },
      { id: 'sameorg', organizationId: 'orgA', systemRole: 'MEMBER', accountType: 'STAFF' },
      { id: 'otherorg', organizationId: 'orgB', systemRole: 'MEMBER', accountType: 'STAFF' },
      { id: 'root', organizationId: 'orgR', systemRole: 'SUPER_ADMIN', accountType: 'STAFF' },
      { id: 'boss', organizationId: 'orgA', systemRole: 'SUPER_ADMIN', accountType: 'STAFF' },
    ];
    const { prisma, sessions, deleteCalls } = makePrisma(
      [
        session('t1', 'sameorg'),
        session('t2', 'sameorg'),
        session('o1', 'otherorg'),
        session('b1', 'boss'),
      ],
      users,
    );
    const audits: { action: string; organizationId: string; target?: string | null }[] = [];
    const audit = { emit: async (a: (typeof audits)[number]) => void audits.push(a) } as unknown as AuditLogService;
    const revokedUsers: string[][] = [];
    const realtime = {
      publishSessionsRevoked: (ids: string[]) => void revokedUsers.push(ids),
    } as unknown as RealtimeEventsService;
    const svc = new AdminUsersService(
      prisma,
      {} as never,
      {} as never,
      audit,
      new SessionsService(prisma),
      realtime,
    );
    // The permission lookup hits the real database; the tier is what is
    // under test here, so stub the admin gate.
    svc.assertAdmin = async () => undefined;

    check(
      'admin revoke other org refused',
      await rejects(svc.revokeUserSessions('admin', 'otherorg'), ForbiddenException),
    );
    check('other org sessions kept', sessions.some((s) => s.id === 'o1'));
    check('no delete issued for refused call', deleteCalls.length === 0);
    check(
      'super admin also refused cross-org',
      await rejects(svc.revokeUserSessions('root', 'sameorg'), ForbiddenException),
    );
    check('same-org sessions kept after cross-org refusal', sessions.filter((s) => s.userId === 'sameorg').length === 2);
    check(
      'admin cannot sign out a higher tier',
      await rejects(svc.revokeUserSessions('admin', 'boss'), ForbiddenException),
    );
    check(
      'admin cannot target self here',
      await rejects(svc.revokeUserSessions('admin', 'admin'), ForbiddenException),
    );
    check(
      'unknown user 404',
      await rejects(svc.revokeUserSessions('admin', 'ghost'), NotFoundException),
    );
    const n = await svc.revokeUserSessions('admin', 'sameorg');
    check('same-org revoke count', n === 2, String(n));
    check('same-org sessions gone, others intact', sessions.map((s) => s.id).sort().join(',') === 'b1,o1');
    check(
      'audited as user.sessions_revoked',
      audits.length === 1 &&
        audits[0]?.action === 'user.sessions_revoked' &&
        audits[0]?.organizationId === 'orgA' &&
        audits[0]?.target === 'user:sameorg',
      JSON.stringify(audits),
    );
    check('sockets revoked for target only', revokedUsers.length === 1 && revokedUsers[0]?.join() === 'sameorg');
  }

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('sessions: all checks passed');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
