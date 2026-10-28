import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Prisma, rawPrisma } from '@botss/database';

import { clearRequestAuth } from '../common/request-context';
import { RedisService } from '../redis/redis.service';
import { assertSupportWriteAllowed } from '../support/support-write-backstop';
import type { AuthContextRows } from './auth-context';

/** Short on purpose: the backstop if an invalidation is ever missed. */
export const AUTH_CONTEXT_TTL_SECONDS = 30;
/** A Redis call slower than this is abandoned and the DB is used instead. */
const REDIS_TIMEOUT_MS = 100;
/** Writes inside a transaction are re-invalidated after it has had time to
 *  commit, so a read that raced the uncommitted write can't keep a stale
 *  snapshot for the whole TTL. */
const TX_REINVALIDATE_MS = 1500;

const KEY_PREFIX = 'authctx:v1:';
const EPOCH_KEY = 'authctx:v1:epoch';

/**
 * Models whose every write can change some user's request context:
 * memberships, overrides and custom roles (a role edit changes everyone
 * holding it).
 */
const ALWAYS_MODELS = new Set([
  'WorkspaceMembership',
  'ProjectMembership',
  'UserPermissionOverride',
  'Role',
]);

/** Models where only some columns feed the context. Hard deletes always count. */
const FIELD_MODELS: Record<string, readonly string[]> = {
  User: ['systemRole', 'organizationId', 'accountType', 'deletedAt', 'customRoleId'],
  Organization: ['deletedAt', 'isActive'],
  Workspace: ['deletedAt', 'organizationId'],
  // A project moving workspace changes `projectMemberships[].workspaceId`;
  // a hard delete cascades its memberships away.
  Project: ['workspaceId'],
};

const WRITE_ACTIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

function touchesAny(data: unknown, fields: readonly string[]): boolean {
  if (!data || typeof data !== 'object') return false;
  const rows = Array.isArray(data) ? data : [data];
  return rows.some(
    (row) => !!row && typeof row === 'object' && fields.some((f) => f in (row as object)),
  );
}

/**
 * Does this Prisma operation change data that `loadAuthContextRows` reads?
 * Pure, so the invalidation rules are checked without a database.
 */
export function isAuthContextWrite(
  model: string | undefined,
  action: string,
  args: unknown,
): boolean {
  if (!model || !WRITE_ACTIONS.has(action)) return false;
  if (ALWAYS_MODELS.has(model)) return true;
  const fields = FIELD_MODELS[model];
  if (!fields) return false;
  if (action === 'delete' || action === 'deleteMany') return true;
  // A brand-new row has no cached context yet.
  if (action === 'create' || action === 'createMany' || action === 'createManyAndReturn') {
    return false;
  }
  const a = (args ?? {}) as { data?: unknown; update?: unknown; create?: unknown };
  if (action === 'upsert') return touchesAny(a.update, fields) || touchesAny(a.create, fields);
  return touchesAny(a.data, fields);
}

interface CachedEntry {
  /** Epoch read before the rows were loaded; a bump since then voids it. */
  e: string;
  rows: AuthContextRows;
}

/**
 * Short-TTL Redis cache of `AuthContextRows`, one key per user.
 *
 * Invalidation is a single global epoch. Every write that can change a
 * context (detected centrally by a Prisma middleware on the base client, so
 * no call site can forget it - including writes made through the
 * soft-delete-extended client and inside transactions) bumps the epoch; a
 * cached entry is only used while its recorded epoch is still current. Such
 * writes are admin actions and rare, so a global epoch costs little hit rate
 * and needs no per-user key bookkeeping.
 *
 * Redis is an optimisation only: when it is down, slow or not yet connected
 * every call falls through to the database, and nothing here throws.
 */
@Injectable()
export class AuthContextCache implements OnModuleInit {
  private readonly logger = new Logger(AuthContextCache.name);
  private static middlewareInstalled = false;

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    if (AuthContextCache.middlewareInstalled) return;
    AuthContextCache.middlewareInstalled = true;
    // `$use` on the BASE client also runs for the soft-delete extended client
    // (`prisma`), for interactive transaction clients and for the extension's
    // own delete → update rewrite, which all funnel through it.
    rawPrisma.$use(async (params: Prisma.MiddlewareParams, next) => {
      // Read only support session: refuse every write before it runs.
      assertSupportWriteAllowed(params.action);
      const result: unknown = await next(params);
      if (isAuthContextWrite(params.model, params.action, params.args)) {
        clearRequestAuth();
        await this.invalidateAll();
        if (params.runInTransaction) {
          setTimeout(() => void this.invalidateAll(), TX_REINVALIDATE_MS).unref?.();
        }
      }
      return result;
    });
  }

  /** Cached rows for a user, or null on miss / stale / Redis trouble. The
   *  returned epoch must be passed to `set` after loading from the DB. */
  async get(userId: string): Promise<{ rows: AuthContextRows | null; epoch: string | null }> {
    const res = await this.withTimeout((c) => c.mget(KEY_PREFIX + userId, EPOCH_KEY));
    if (!res) return { rows: null, epoch: null };
    const [raw, epochRaw] = res;
    const epoch = epochRaw ?? '0';
    if (!raw) return { rows: null, epoch };
    try {
      const entry = JSON.parse(raw) as CachedEntry;
      return { rows: entry.e === epoch ? entry.rows : null, epoch };
    } catch {
      return { rows: null, epoch };
    }
  }

  async set(userId: string, epoch: string | null, rows: AuthContextRows): Promise<void> {
    // No epoch means Redis was unavailable at read time; don't write a value
    // we can't tie to an epoch.
    if (epoch === null) return;
    const entry: CachedEntry = { e: epoch, rows };
    await this.withTimeout((c) =>
      c.set(KEY_PREFIX + userId, JSON.stringify(entry), 'EX', AUTH_CONTEXT_TTL_SECONDS),
    );
  }

  /** Void every cached context. */
  async invalidateAll(): Promise<void> {
    const ok = await this.withTimeout((c) => c.incr(EPOCH_KEY));
    if (ok === null) {
      this.logger.warn(
        `Auth context invalidation skipped (Redis unavailable); entries expire within ${AUTH_CONTEXT_TTL_SECONDS}s.`,
      );
    }
  }

  private async withTimeout<T>(
    fn: (client: RedisService['client']) => Promise<T>,
  ): Promise<T | null> {
    let client: RedisService['client'];
    try {
      client = this.redis.client;
    } catch {
      return null;
    }
    // ioredis queues commands while disconnected (maxRetriesPerRequest: null),
    // which would hang the request. Only talk to a ready connection.
    if (client.status !== 'ready') return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(client),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), REDIS_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.logger.debug(`Auth context cache call failed: ${(err as Error)?.message ?? 'unknown'}`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
