import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: { postgres: boolean; redis: boolean };
  timestamp: string;
}

/**
 * Postgres + Redis readiness, shared by the HTTP probe (HealthController)
 * and the worker's health server. Each probe is bounded: RedisService uses
 * `maxRetriesPerRequest: null`, which queues commands indefinitely while
 * disconnected, so an unbounded check could hang forever.
 */
export async function checkReadiness(
  prisma: Pick<PrismaService, 'raw'>,
  redis: Pick<RedisService, 'client'>,
  timeoutMs = 2_000,
): Promise<ReadinessReport> {
  const checks = { postgres: false, redis: false };
  try {
    await withTimeout(prisma.raw.$queryRaw`SELECT 1`, timeoutMs);
    checks.postgres = true;
  } catch {
    checks.postgres = false;
  }
  try {
    const pong = await withTimeout(redis.client.ping(), timeoutMs);
    checks.redis = pong === 'PONG';
  } catch {
    checks.redis = false;
  }
  return {
    status: checks.postgres && checks.redis ? 'ok' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
