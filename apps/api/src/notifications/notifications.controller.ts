import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  cuid,
  type ListNotificationsQuery,
  listNotificationsQuerySchema,
  type MarkReadByEntityInput,
  markReadByEntitySchema,
  type RegisterPushDeviceInput,
  registerPushDeviceSchema,
  type SubscribePushInput,
  subscribePushSchema,
  unregisterPushDeviceSchema,
} from '@botss/shared-types';
import { z } from 'zod';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { NotificationsPushService } from './notifications-push.service';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly push: NotificationsPushService,
  ) {}

  @Get()
  // Notifications are user-scoped (every authenticated user can read their own
  // bell), so we opt out of the CASL subject map. AuthGuard still enforces
  // authentication.
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema))
    q: ListNotificationsQuery,
  ) {
    return this.notifications.list(user.id, q);
  }

  @Post(':id/read')
  @SkipPermissions()
  markRead(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @SkipPermissions()
  markAllRead(@CurrentUser() user: AuthedUser) {
    return this.notifications.markAllRead(user.id);
  }

  /**
   * Contextual auto-read. The client calls this when the user opens an entity
   * (a chat room, a mail message, a task, a todo, a project) so any unread
   * notifications about it clear from the bell without an explicit click.
   */
  @Post('read-by-entity')
  @SkipPermissions()
  markReadByEntity(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(markReadByEntitySchema))
    input: MarkReadByEntityInput,
  ) {
    return this.notifications.markReadByEntity(
      user.id,
      input.entityType,
      input.entityId,
    );
  }

  /**
   * Register the calling browser/device for native OS push. Idempotent -
   * the same `endpoint` upserts in place so reloads don't pile up
   * duplicate rows.
   */
  @Post('subscribe')
  @SkipPermissions()
  subscribe(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(subscribePushSchema)) input: SubscribePushInput,
  ) {
    return this.push.subscribe(user.id, input);
  }

  /**
   * Remove a specific push subscription. Called when the browser
   * permission is revoked or on sign-out.
   */
  @Delete('subscribe')
  @SkipPermissions()
  unsubscribe(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(z.object({ endpoint: z.string().url() })))
    body: { endpoint: string },
  ) {
    return this.push.unsubscribe(user.id, body.endpoint);
  }

  /**
   * Register a NATIVE device token (Expo/FCM/APNs) for OS push that reaches a
   * fully closed mobile app. The mobile shell posts this once the WebView
   * session resolves, so it's authenticated by the user's session like the rest
   * of the bell. Idempotent - upserts by token.
   */
  @Post('devices')
  @SkipPermissions()
  registerDevice(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(registerPushDeviceSchema))
    input: RegisterPushDeviceInput,
  ) {
    return this.push.registerDevice(user.id, input);
  }

  /** Drop a native device token (sign-out / permission revoked). */
  @Delete('devices')
  @SkipPermissions()
  unregisterDevice(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(unregisterPushDeviceSchema))
    body: { token: string },
  ) {
    return this.push.unregisterDevice(user.id, body.token);
  }
}
