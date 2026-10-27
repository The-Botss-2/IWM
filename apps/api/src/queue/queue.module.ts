import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { bullExtraOptionsForRole, getProcessRole } from '../common/process-role';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // ROLE=api: queues stay usable for enqueueing, but no @Processor gets
      // a BullMQ Worker. The worker process (or ROLE=all) consumes the jobs.
      extraOptions: bullExtraOptionsForRole(getProcessRole()),
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379');
        // The database number (`redis://host:6380/1`) must reach BullMQ too:
        // staging shares production's Redis on the same host, and without it
        // staging workers would pick up production's jobs (emails, mail sync).
        const db = parseInt(url.pathname.replace(/^\//, '') || '0', 10);
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            username: url.username || undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            db: Number.isNaN(db) ? 0 : db,
          },
        };
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
