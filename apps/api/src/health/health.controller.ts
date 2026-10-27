import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../common/decorators/public.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { checkReadiness, type ReadinessReport } from './readiness';

/**
 * Liveness + readiness probes. Both are unauthenticated on purpose: a load
 * balancer, process manager or deploy health check must be able to
 * reach them without a session. They expose no business data - only up/down
 * status of the process and its two hard dependencies (Postgres, Redis).
 *
 * - `GET /health`        liveness: the event loop is responding. No I/O.
 * - `GET /health/ready`  readiness: Postgres + Redis answer within a timeout.
 *                        Returns 503 (not 500) when a dependency is down so a
 *                        probe treats it as "not ready" rather than a crash.
 *
 * The ROLE=worker process serves the same two probes from its own small
 * server (health/worker-health-server.ts) on WORKER_HEALTH_PORT.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Public()
  @SkipPermissions()
  liveness(): { status: 'ok'; uptimeSeconds: number; timestamp: string } {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  @Public()
  @SkipPermissions()
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await checkReadiness(this.prisma, this.redis);
    res.status(report.status === 'ok' ? 200 : 503);
    return report;
  }
}
