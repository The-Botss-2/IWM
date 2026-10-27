import { type INestApplicationContext, Logger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import {
  parseWorkerHealthPort,
  startWorkerHealthServer,
  type WorkerHealthDeps,
} from './health/worker-health-server';
import { PrismaService } from './prisma/prisma.service';
import { waitForNoLiveAllProcess } from './redis/process-presence.service';
import { RedisService } from './redis/redis.service';

/**
 * Boot for ROLE=worker: the same module graph as the API, but as a plain
 * application context. No Express, no routes, no Socket.IO server (gateways
 * are never initialized). BullMQ workers register in onModuleInit, IMAP IDLE
 * and the schedulers start in onApplicationBootstrap, exactly as in ROLE=all.
 * The only listener is the health server on WORKER_HEALTH_PORT.
 */
export async function bootstrapWorker(logLevels: LogLevel[]): Promise<void> {
  const logger = new Logger('WorkerBootstrap');
  const healthPort = parseWorkerHealthPort(process.env.WORKER_HEALTH_PORT);

  // Bound first: a port already in use fails the boot here, before any
  // BullMQ worker or IDLE watcher exists. /health/ready is 503 until the
  // context below is up.
  let deps: WorkerHealthDeps | null = null;
  const health = await startWorkerHealthServer({ port: healthPort, readiness: () => deps });

  let app: INestApplicationContext | null = null;
  try {
    // Before any BullMQ worker or IDLE watcher exists: never run alongside a
    // ROLE=all process, which already does all of this work.
    const guard = await waitForNoLiveAllProcess(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxWaitMs: 20_000,
      pollMs: 1_000,
      log: (m) => logger.warn(m),
    });
    if (!guard.ok) {
      throw new Error(`Worker not started: ${guard.reason}`);
    }

    app = await NestFactory.createApplicationContext(AppModule, {
      bufferLogs: false,
      logger: logLevels,
    });
    // SIGINT/SIGTERM close the BullMQ workers (letting the active job finish
    // within the process manager's kill timeout), the IDLE watchers and the pools. A job cut
    // off by SIGKILL is not lost: BullMQ re-queues it as stalled.
    app.enableShutdownHooks();
    deps = { prisma: app.get(PrismaService), redis: app.get(RedisService) };
  } catch (err) {
    // A half-booted context may already run BullMQ workers or IDLE watchers:
    // close it before the process exits.
    if (app) {
      await app.close().catch((closeErr: unknown) => {
        logger.error(
          `Closing the worker after a failed boot failed: ${(closeErr as Error)?.message ?? 'unknown'}`,
        );
      });
    }
    await new Promise<void>((resolve) => health.close(() => resolve()));
    throw err;
  }

  logger.log(
    `Worker running. Health at http://127.0.0.1:${healthPort}/health and /health/ready`,
  );
  logger.log(`Log levels enabled: ${logLevels.join(', ')}`);

  if (typeof process.send === 'function') {
    process.send('ready');
  }
}
