import { createServer, type Server } from 'node:http';

import type { PrismaService } from '../prisma/prisma.service';
import type { RedisService } from '../redis/redis.service';
import { checkReadiness } from './readiness';

/** Production default. Staging's worker sets WORKER_HEALTH_PORT=4101. */
export const DEFAULT_WORKER_HEALTH_PORT = 4100;

export function parseWorkerHealthPort(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_WORKER_HEALTH_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid WORKER_HEALTH_PORT=${JSON.stringify(raw)}; expected a TCP port.`);
  }
  return port;
}

export interface WorkerHealthDeps {
  prisma: Pick<PrismaService, 'raw'>;
  redis: Pick<RedisService, 'client'>;
}

/**
 * The worker's only listener: `GET /health` (alive) and `GET /health/ready`
 * (Postgres + Redis), same bodies as the API's probes. Bound to 127.0.0.1;
 * it is for process-manager and deploy checks on the host, never for the internet.
 *
 * It is bound before the Nest context boots, so a port clash fails the boot
 * before any BullMQ worker or IDLE watcher starts. Until `readiness()`
 * returns the context's services, `/health/ready` answers 503 degraded.
 */
export function startWorkerHealthServer(args: {
  port: number;
  host?: string;
  readiness: () => WorkerHealthDeps | null;
}): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!.replace(/\/+$/, '') || '/';
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { title: 'Method not allowed', status: 405 });
      return;
    }
    if (path === '/health') {
      send(200, {
        status: 'ok',
        role: 'worker',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (path === '/health/ready') {
      const deps = args.readiness();
      if (!deps) {
        send(503, {
          status: 'degraded',
          checks: { postgres: false, redis: false },
          timestamp: new Date().toISOString(),
        });
        return;
      }
      void checkReadiness(deps.prisma, deps.redis).then(
        (report) => send(report.status === 'ok' ? 200 : 503, report),
        () => send(503, { status: 'degraded', checks: { postgres: false, redis: false } }),
      );
      return;
    }
    send(404, { title: 'Not found', status: 404 });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, args.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
