import type { FinanceSummary, FinanceSummaryQuery } from '@botss/shared-types';

import type { RedisService } from '../redis/redis.service';

/**
 * A short Redis cache in front of `FinanceSummaryService.summary`.
 *
 * Invalidation is O(1) through a per-workspace epoch: every finance write
 * INCRs `finsum:epoch:<workspaceId>` AFTER its transaction commits, and a
 * cached value is only served while the epoch it was computed under is still
 * the current one. A summary computed concurrently with a write therefore
 * carries the old epoch and is never served after the bump.
 *
 * Redis is strictly optional here: every call is skipped unless the client is
 * `ready`, is capped at REDIS_TIMEOUT_MS, and swallows errors, so a slow or
 * dead Redis only costs the cache, never the request.
 *
 * Keys (deploy notes):
 *   finsum:epoch:<workspaceId>   integer, refreshed to EPOCH_TTL_SECONDS on each bump
 *   finsum:v1:<workspaceId>:<from>:<to>:<projectId>:<clientId>
 *                                JSON { epoch, data }, TTL FINANCE_SUMMARY_TTL_SECONDS
 */
export const FINANCE_SUMMARY_TTL_SECONDS = 45;
const EPOCH_TTL_SECONDS = 30 * 24 * 60 * 60;
const REDIS_TIMEOUT_MS = 100;

const epochKey = (workspaceId: string) => `finsum:epoch:${workspaceId}`;

export function financeSummaryKey(workspaceId: string, q: FinanceSummaryQuery): string {
  return [
    'finsum:v1',
    workspaceId,
    q.from.toISOString(),
    q.to.toISOString(),
    q.projectId ?? '',
    q.clientId ?? '',
  ].join(':');
}

/** The ioredis client when it can take a command right now, else null. */
function readyClient(redis: RedisService) {
  try {
    const client = redis.client;
    return client.status === 'ready' ? client : null;
  } catch {
    return null;
  }
}

/** Resolve to `undefined` instead of waiting past `ms` or throwing. */
async function bounded<T>(work: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface CachedEntry {
  epoch: string;
  data: FinanceSummary;
}

export interface CacheLookup {
  /** The epoch to store a freshly computed summary under. */
  epoch: string;
  /** The cached summary, already re-hydrated, when it is still current. */
  hit: FinanceSummary | null;
}

/**
 * One round trip (MGET of the epoch and the value). Null when Redis is not
 * usable, in which case the caller computes and does not store.
 */
export async function readFinanceSummary(
  redis: RedisService,
  workspaceId: string,
  q: FinanceSummaryQuery,
): Promise<CacheLookup | null> {
  const client = readyClient(redis);
  if (!client) return null;
  const res = await bounded(client.mget(epochKey(workspaceId), financeSummaryKey(workspaceId, q)));
  if (!res) return null;
  const epoch = res[0] ?? '0';
  const raw = res[1];
  if (!raw) return { epoch, hit: null };
  try {
    const entry = JSON.parse(raw) as CachedEntry;
    if (entry.epoch !== epoch) return { epoch, hit: null };
    // JSON turned `range` into ISO strings; everything else in the summary is
    // strings and numbers already. The key pins from/to, so the query's own
    // Dates are exactly the ones the cached value was computed for. Spreading
    // keeps `range` in its original key position.
    return { epoch, hit: { ...entry.data, range: { from: q.from, to: q.to } } };
  } catch {
    return { epoch, hit: null };
  }
}

/** Fire and forget: storing never delays the response. */
export function storeFinanceSummary(
  redis: RedisService,
  workspaceId: string,
  q: FinanceSummaryQuery,
  epoch: string,
  data: FinanceSummary,
): void {
  const client = readyClient(redis);
  if (!client) return;
  const entry: CachedEntry = { epoch, data };
  client
    .set(
      financeSummaryKey(workspaceId, q),
      JSON.stringify(entry),
      'EX',
      FINANCE_SUMMARY_TTL_SECONDS,
    )
    .catch(() => undefined);
}

/**
 * Invalidate every cached summary of these workspaces. Call it AFTER the
 * write has committed. Awaited (bounded) so the caller's next read normally
 * misses; a Redis outage leaves at most FINANCE_SUMMARY_TTL_SECONDS of
 * staleness.
 */
export async function bumpFinanceSummary(
  redis: RedisService,
  ...workspaceIds: Array<string | null | undefined>
): Promise<void> {
  const ids = [...new Set(workspaceIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const client = readyClient(redis);
  if (!client) return;
  const multi = client.multi();
  for (const id of ids) multi.incr(epochKey(id)).expire(epochKey(id), EPOCH_TTL_SECONDS);
  await bounded(multi.exec());
}
