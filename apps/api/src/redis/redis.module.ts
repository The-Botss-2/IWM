import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '@nestjs/config';

import { CrossProcessBus } from './cross-process-bus.service';
import { ProcessPresenceService } from './process-presence.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService, CrossProcessBus, ProcessPresenceService],
  exports: [RedisService, CrossProcessBus],
})
export class RedisModule {}
