import { Global, Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller';
import { NotificationsPushService } from './notifications-push.service';
import { NotificationsService } from './notifications.service';
import { RealtimeEventsService } from './realtime-events.service';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsPushService, RealtimeEventsService],
  exports: [NotificationsService, NotificationsPushService, RealtimeEventsService],
})
export class NotificationsModule {}
