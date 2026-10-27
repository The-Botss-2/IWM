import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * PrismaModule and RedisModule are both @Global(), so their services are
 * injectable here without re-importing them.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
