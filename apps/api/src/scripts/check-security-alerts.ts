/**
 * Security alert self-checks (no database, no Redis): fake Redis with TTL
 * bookkeeping, fake Prisma and a recording audit log. Covered: each threshold
 * triggers exactly once per window, below threshold nothing is raised, a Redis
 * failure never throws, Redis that is not ready is skipped, a purge's deletes
 * are not counted, and no alert metadata carries an email or password.
 *
 * Run: pnpm --filter @botss/api test
 */
import 'reflect-metadata';

import assert from 'node:assert/strict';

import { presetPermissions } from '@botss/auth';
import { PLATFORM_AUDIT_ACTIONS, SECURITY_ALERT_ACTIONS } from '@botss/shared-types';
import type { Request, Response } from 'express';

import type { AuditLogService } from '../audit-log/audit-log.service';
import { RequestContextMiddleware, setRequestAuth } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { withoutDeleteCounting } from '../security-alerts/delete-counting';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';

const ORG = 'cmorga00000000000000000a1';
const USER = 'cmuser000000000000000000a';
const EMAIL = 'someone@example.test';

interface Emitted {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  target?: string | null;
  metadata?: Record<string, unknown>;
}

function setup(options: { redisFails?: boolean; status?: string } = {}) {
  const store = new Map<string, number>();
  const ttl = new Map<string, number>();
  let calls = 0;
  const incrby = (key: string, by: number): number => {
    const next = (store.get(key) ?? 0) + by;
    store.set(key, next);
    return next;
  };
  // EXPIRE ... NX: only sets a TTL on a key that has none.
  const expireNx = (key: string, seconds: number): number => {
    if (ttl.has(key)) return 0;
    ttl.set(key, seconds);
    return 1;
  };
  const redis = {
    client: {
      status: options.status ?? 'ready',
      multi() {
        const ops: Array<() => unknown> = [];
        const chain = {
          incrby(key: string, by: number) {
            ops.push(() => incrby(key, by));
            return chain;
          },
          expire(key: string, seconds: number, mode: 'NX') {
            assert.equal(mode, 'NX', 'TTL only set when the window opens');
            ops.push(() => expireNx(key, seconds));
            return chain;
          },
          async exec() {
            calls++;
            if (options.redisFails) throw new Error('redis down');
            return ops.map((op) => [null, op()]);
          },
        };
        return chain;
      },
      async expire(key: string, seconds: number) {
        calls++;
        ttl.set(key, seconds);
        return 1;
      },
      async set(key: string, _v: string, _ex: 'EX', seconds: number, _nx: 'NX') {
        calls++;
        if (options.redisFails) throw new Error('redis down');
        if (store.has(key)) return null;
        store.set(key, 1);
        ttl.set(key, seconds);
        return 'OK';
      },
    },
  } as unknown as RedisService;
  const prisma = {
    client: {
      user: {
        findFirst: async (args: { where: { email: string } }) =>
          args.where.email === EMAIL ? { organizationId: ORG } : null,
        findUnique: async () => ({ organizationId: ORG }),
      },
    },
  } as unknown as PrismaService;
  const emitted: Emitted[] = [];
  const audit = {
    emit: async (row: Emitted) => {
      emitted.push(row);
    },
  } as unknown as AuditLogService;
  return {
    service: new SecurityAlertsService(redis, prisma, audit),
    emitted,
    ttl,
    redisCalls: () => calls,
  };
}

function asUser<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    new RequestContextMiddleware().use({} as Request, {} as Response, () => {
      setRequestAuth({
        userId: USER,
        systemRole: 'EMPLOYEE',
        organizationId: ORG,
        permissions: presetPermissions({ systemRole: 'EMPLOYEE' }),
      });
      fn().then(resolve, reject);
    });
  });
}

function assertClean(rows: Emitted[]): void {
  for (const row of rows) {
    const text = JSON.stringify(row.metadata ?? {}).toLowerCase();
    assert.ok(!text.includes('@'), `${row.action} metadata has no email`);
    assert.ok(!text.includes('password'), `${row.action} metadata has no password`);
    assert.ok(!text.includes(EMAIL), `${row.action} metadata has no address`);
  }
}

async function main(): Promise<void> {
  {
    // Every alert is visible in the platform log.
    for (const action of SECURITY_ALERT_ACTIONS) {
      assert.ok((PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action), `${action} is a platform action`);
    }
  }
  {
    const { service, emitted, ttl } = setup();
    for (let i = 0; i < 19; i++) await service.recordFailedSignIn(EMAIL);
    assert.equal(emitted.length, 0, 'below 20 failed sign-ins: no alert');
    await service.recordFailedSignIn(EMAIL);
    assert.equal(emitted.length, 1, '20th failed sign-in raises the alert');
    for (let i = 0; i < 30; i++) await service.recordFailedSignIn(EMAIL);
    assert.equal(emitted.length, 1, 'only one alert per window');
    assert.equal(emitted[0]?.action, 'security.failed_signins');
    assert.equal(emitted[0]?.organizationId, ORG);
    assert.equal(emitted[0]?.actorUserId, null);
    assert.equal(ttl.get(`sec:signin:${ORG}`), 3600, 'one hour window');
    assertClean(emitted);
    await service.recordFailedSignIn('nobody@example.test');
    await service.recordFailedSignIn('');
    assert.equal(emitted.length, 1, 'unknown or empty email is skipped');
  }
  {
    const { service, emitted, ttl } = setup();
    await asUser(async () => {
      await service.recordDeletes(49);
      assert.equal(emitted.length, 0, 'below 50 deletes: no alert');
      await service.recordDeletes(1);
      assert.equal(emitted.length, 1, '50 deletes raise the alert');
      await service.recordDeletes(20);
      assert.equal(emitted.length, 1, 'only one alert per window');
    });
    assert.equal(emitted[0]?.action, 'security.mass_delete');
    assert.equal(emitted[0]?.actorUserId, USER);
    assert.equal(emitted[0]?.metadata?.['userId'], USER);
    assert.equal(ttl.get(`sec:delete:${USER}`), 600, 'ten minute window');
    assertClean(emitted);
    // Outside a request there is no user to attribute: nothing happens.
    await service.recordDeletes(500);
    assert.equal(emitted.length, 1, 'no request context: ignored');
  }
  {
    const { service, emitted } = setup();
    await service.recordExport(USER, 499);
    await service.recordImport(USER, 499);
    assert.equal(emitted.length, 0, 'below 500 rows: no alert');
    await service.recordExport(USER, 500);
    await service.recordImport(USER, 1200);
    assert.deepEqual(
      emitted.map((e) => e.action),
      ['security.large_export', 'security.large_import'],
    );
    assert.equal(emitted[1]?.metadata?.['rows'], 1200);
    assertClean(emitted);
  }
  {
    const { service, emitted } = setup();
    await service.recordNewAdmin({
      organizationId: ORG,
      actorUserId: null,
      userId: USER,
      scope: 'system',
      role: 'ADMIN',
    });
    assert.equal(emitted[0]?.action, 'security.new_admin');
    assert.deepEqual(emitted[0]?.metadata, { userId: USER, scope: 'system', role: 'ADMIN' });
    assertClean(emitted);
  }
  {
    // Redis down: nothing throws, nothing is raised.
    const { service, emitted } = setup({ redisFails: true });
    await service.recordFailedSignIn(EMAIL);
    await asUser(() => service.recordDeletes(100));
    assert.equal(emitted.length, 0, 'redis failure raises nothing and never throws');
  }
  {
    // Redis not connected: return at once, never queue a command.
    const { service, emitted, redisCalls } = setup({ status: 'reconnecting' });
    for (let i = 0; i < 25; i++) await service.recordFailedSignIn(EMAIL);
    await asUser(() => service.recordDeletes(100));
    assert.equal(redisCalls(), 0, 'no Redis command while not ready');
    assert.equal(emitted.length, 0, 'nothing raised while Redis is not ready');
  }
  {
    // The super admin purge of an organization is not a person's mass delete.
    const { service, emitted } = setup();
    await asUser(() => withoutDeleteCounting(() => service.recordDeletes(500)));
    assert.equal(emitted.length, 0, 'suppressed deletes are not counted');
    await asUser(() => service.recordDeletes(49));
    assert.equal(emitted.length, 0, 'the suppressed 500 did not add to the window');
  }
  {
    // The TTL survives later bumps (NX), so the window does not slide.
    const { service, ttl } = setup();
    await asUser(async () => {
      await service.recordDeletes(1);
      ttl.set(`sec:delete:${USER}`, 42);
      await service.recordDeletes(1);
    });
    assert.equal(ttl.get(`sec:delete:${USER}`), 42, 'a later bump keeps the existing TTL');
  }

  console.log('check-security-alerts: OK');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
