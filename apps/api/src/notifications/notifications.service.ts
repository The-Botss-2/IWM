import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ListNotificationsQuery,
  NotificationEntityType,
  NotificationType,
} from '@botss/shared-types';
import type { Notification } from '@botss/database';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsPushService } from './notifications-push.service';
import { RealtimeEventsService } from './realtime-events.service';

interface CreateNotificationArgs {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  title: string;
  body: string;
  taskId?: string | null;
  commentId?: string | null;
  /** Generic entity link - powers deep-linking + contextual auto-read. */
  entityType?: NotificationEntityType | null;
  entityId?: string | null;
  /** Deep-link the bell row + OS banner navigate to. Defaults to '/'. */
  url?: string | null;
  /** OS web-push stickiness/audio hint. 'generic' (default) suits most;
   *  'call' makes the banner sticky; 'message' for chat. */
  pushType?: 'message' | 'call' | 'generic';
  /** Skip the OS web-push leg (still writes the bell row). Used when the
   *  caller already delivered an OS banner through another path - e.g. chat,
   *  which fans out its own push for every message. */
  skipPush?: boolean;
}

/**
 * In-app + OS notification surface. Other modules call `emit(...)` (or
 * `emitMany`) right after the originating write completes. This is the SINGLE
 * fan-out point: it (1) persists the bell row and (2) fires an OS web-push to
 * the recipient's subscribed devices. Both legs are best-effort - a failure
 * here MUST NOT roll back the user-facing action, so callers wrap in try/catch
 * AND the push leg is fire-and-forget.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: NotificationsPushService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  async list(userId: string, q: ListNotificationsQuery) {
    const where: Record<string, unknown> = { userId };
    if (q.unreadOnly) where['readAt'] = null;

    const [items, unreadCount] = await Promise.all([
      this.prisma.client.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        include: {
          actor: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      this.prisma.client.notification.count({
        where: { userId, readAt: null },
      }),
    ]);
    return { items, unreadCount };
  }

  async markRead(userId: string, notificationId: string) {
    const existing = await this.prisma.client.notification.findFirst({
      where: { id: notificationId, userId },
      select: { id: true, readAt: true },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Notification not found', status: 404 });
    }
    if (existing.readAt) return { ok: true };
    await this.prisma.client.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.client.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Contextual auto-read: clear every unread notification this user has for a
   * given entity. Called when the user actually opens the thing (a chat room,
   * a mail message, a task, a todo, a project) so the bell doesn't keep
   * surfacing something they've already seen.
   */
  async markReadByEntity(
    userId: string,
    entityType: NotificationEntityType,
    entityId: string,
  ) {
    await this.prisma.client.notification.updateMany({
      where: { userId, entityType, entityId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Persist a notification row AND fan out an OS web-push to the recipient's
   * devices. The push is fire-and-forget (the push service swallows its own
   * per-device errors and no-ops when VAPID isn't configured). Self-notifying
   * is the caller's responsibility - skip emit when actorId === userId.
   */
  async emit(args: CreateNotificationArgs) {
    const row = await this.prisma.client.notification.create({
      data: toNotificationData(args),
    });
    this.fanOut(row, args);
    return row;
  }

  /**
   * Post-persist side effects for one bell row: the realtime publish and the
   * fire-and-forget OS push. Shared by `emit` and the batched `emitMany` so
   * both paths deliver exactly the same events per recipient.
   */
  private fanOut(row: Notification, args: CreateNotificationArgs): void {
    // Live bell refresh on every connected client. Runs even when `skipPush`
    // is set. The desktop OS banner does not come from this event: it comes
    // from the push leg below (`os_notification`), so a skipPush row (chat,
    // whose own push already bannered the message) never pops up twice.
    this.realtime.publishNotification({
      userId: row.userId,
      notification: {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        url: row.url,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt,
      },
    });

    if (args.skipPush) return;

    // OS banner on every device: phones (Expo), browsers (Web Push) and the
    // desktop app (live socket). Fire-and-forget: the request must not wait
    // on push delivery, and a push failure must never surface to the caller.
    void this.push
      .sendDesktopNotification(args.userId, {
        title: args.title.slice(0, 120),
        body: args.body.slice(0, 400),
        type: args.pushType ?? 'generic',
        url: (args.url && args.url.length > 0 ? args.url : '/').slice(0, 2048),
        // Collapse repeated banners about the same entity into one.
        ...(args.entityType && args.entityId
          ? { tag: `${args.entityType}:${args.entityId}` }
          : {}),
        data: {
          notificationId: row.id,
          ...(args.entityType ? { entityType: args.entityType } : {}),
          ...(args.entityId ? { entityId: args.entityId } : {}),
        },
      })
      .catch((err) => {
        this.logger.warn(
          `web-push fan-out failed userId=${args.userId}: ${(err as Error)?.message ?? 'unknown'}`,
        );
      });
  }

  /**
   * Emit the same notification to many recipients at once. De-dupes the id
   * list and skips falsy ids. Per-recipient failures are isolated so one bad
   * row never blocks the rest.
   */
  async emitMany(
    userIds: Array<string | null | undefined>,
    args: Omit<CreateNotificationArgs, 'userId'>,
  ) {
    const unique = Array.from(new Set(userIds.filter((id): id is string => !!id)));
    if (unique.length === 0) return;

    // Fast path: one multi-row INSERT for every recipient, then the same
    // per-row realtime + push fan-out `emit` performs.
    let rows: Notification[] | null = null;
    try {
      rows = await this.prisma.client.notification.createManyAndReturn({
        data: unique.map((userId) => toNotificationData({ ...args, userId })),
      });
    } catch (err) {
      // One bad recipient (e.g. an FK violation) fails the whole INSERT. Fall
      // back to the per-recipient path so failures stay isolated as before.
      this.logger.warn(
        `notification batch insert failed (${unique.length} recipients), retrying per row: ${(err as Error)?.message ?? 'unknown'}`,
      );
    }

    if (rows) {
      for (const row of rows) {
        try {
          this.fanOut(row, { ...args, userId: row.userId });
        } catch (err) {
          this.logger.warn(
            `notification emit failed userId=${row.userId}: ${(err as Error)?.message ?? 'unknown'}`,
          );
        }
      }
      return;
    }

    await Promise.all(
      unique.map((userId) =>
        this.emit({ ...args, userId }).catch((err) => {
          this.logger.warn(
            `notification emit failed userId=${userId}: ${(err as Error)?.message ?? 'unknown'}`,
          );
        }),
      ),
    );
  }
}

function toNotificationData(args: CreateNotificationArgs) {
  return {
    userId: args.userId,
    actorId: args.actorId ?? null,
    type: args.type,
    title: args.title,
    body: args.body,
    taskId: args.taskId ?? null,
    commentId: args.commentId ?? null,
    entityType: args.entityType ?? null,
    entityId: args.entityId ?? null,
    url: args.url ?? null,
  };
}
