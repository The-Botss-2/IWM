import { Injectable, Optional } from '@nestjs/common';
import { type RealtimePushEvent, realtimePushEventSchema } from '@botss/shared-types';
import { Subject } from 'rxjs';

import {
  type BusTopic,
  CrossProcessBus,
  isRecord,
  isStringArray,
} from '../redis/cross-process-bus.service';

/** The slice of a bell row a connected client needs to banner and refresh. */
export interface RealtimeNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string | null;
  entityType: string | null;
  entityId: string | null;
  createdAt: Date;
}

export interface RealtimeNotificationEvent {
  userId: string;
  notification: RealtimeNotification;
}

/** One OS push, addressed to every user it went to. */
export interface RealtimePushFanout {
  userIds: string[];
  payload: RealtimePushEvent;
}

const nullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Notification rows written by the worker (crons, chat fan-out) reach the
 *  api process's sockets over this topic. */
export const NOTIFICATION_TOPIC: BusTopic<RealtimeNotificationEvent> = {
  name: 'notifications',
  decode(raw) {
    if (!isRecord(raw) || typeof raw.userId !== 'string' || !isRecord(raw.notification))
      return null;
    const n = raw.notification;
    if (
      typeof n.id !== 'string' ||
      typeof n.type !== 'string' ||
      typeof n.title !== 'string' ||
      typeof n.body !== 'string' ||
      !nullableString(n.url) ||
      !nullableString(n.entityType) ||
      !nullableString(n.entityId) ||
      typeof n.createdAt !== 'string'
    ) {
      return null;
    }
    const createdAt = new Date(n.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return {
      userId: raw.userId,
      notification: {
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        url: n.url,
        entityType: n.entityType,
        entityId: n.entityId,
        createdAt,
      },
    };
  },
};

export const SESSIONS_REVOKED_TOPIC: BusTopic<{ userIds: string[] }> = {
  name: 'sessions-revoked',
  decode(raw) {
    return isRecord(raw) && isStringArray(raw.userIds) ? { userIds: raw.userIds } : null;
  },
};

/** Devices page revokes: only the sockets of these sessions close. */
export const SESSION_IDS_REVOKED_TOPIC: BusTopic<{ userId: string; sessionIds: string[] }> = {
  name: 'session-ids-revoked',
  decode(raw) {
    return isRecord(raw) && typeof raw.userId === 'string' && isStringArray(raw.sessionIds)
      ? { userId: raw.userId, sessionIds: raw.sessionIds }
      : null;
  },
};

/** OS pushes sent from the worker (chat fan-out, crons) reach the api's sockets. */
export const PUSH_TOPIC: BusTopic<RealtimePushFanout> = {
  name: 'pushes',
  decode(raw) {
    if (!isRecord(raw) || !isStringArray(raw.userIds)) return null;
    const payload = realtimePushEventSchema.safeParse(raw.payload);
    return payload.success ? { userIds: raw.userIds, payload: payload.data } : null;
  },
};

/**
 * In-process bus that carries freshly written notification rows to whichever
 * transport can reach the user live. NotificationsService publishes; the chat
 * Socket.IO gateway subscribes and forwards to the user's room.
 *
 * Why this exists: the Electron desktop app has no Push API, so it only saw
 * notifications through the 15 s bell poll, and that poll pauses while the
 * window is hidden in the tray. The socket stays connected in the tray, so
 * pushing rows over it gives the desktop app every notification type in real
 * time, the same coverage mobile gets from native push. Same pattern as
 * MailEventsService, so the gateway and the notification writers never import
 * each other.
 *
 * With ROLE=api + ROLE=worker the writer and the gateway can sit in different
 * processes, so every publish also goes over the CrossProcessBus (a no-op in
 * ROLE=all) and the api process feeds what it receives into the same streams.
 */
@Injectable()
export class RealtimeEventsService {
  private readonly notificationsSubject = new Subject<RealtimeNotificationEvent>();
  private readonly pushesSubject = new Subject<RealtimePushFanout>();
  private readonly sessionsRevokedSubject = new Subject<{ userIds: string[] }>();
  private readonly sessionIdsRevokedSubject = new Subject<{
    userId: string;
    sessionIds: string[];
  }>();

  readonly notifications$ = this.notificationsSubject.asObservable();
  /**
   * Every OS push the server sends (bell rows, chat messages, incoming
   * calls), published by NotificationsPushService at the moment the phones
   * get theirs. The chat gateway forwards it as `os_notification` and the
   * desktop app banners from it, so one server-side decision covers what
   * pops up on every device.
   */
  readonly pushes$ = this.pushesSubject.asObservable();
  /**
   * Users whose sessions were just deleted (password/role change by an
   * admin, account removal, org archive, portal access revoked). A socket
   * authenticates once at connect, so without this it would keep receiving
   * room traffic after the session that opened it is gone. The chat gateway
   * disconnects every socket of these users.
   */
  readonly sessionsRevoked$ = this.sessionsRevokedSubject.asObservable();

  /**
   * Specific sessions of one user were deleted (Devices page). The gateway
   * closes only the sockets opened by those sessions.
   */
  readonly sessionIdsRevoked$ = this.sessionIdsRevokedSubject.asObservable();

  constructor(@Optional() private readonly bus?: CrossProcessBus) {
    this.bus?.subscribe(NOTIFICATION_TOPIC, (e) => this.notificationsSubject.next(e));
    this.bus?.subscribe(PUSH_TOPIC, (e) => this.pushesSubject.next(e));
    this.bus?.subscribe(SESSIONS_REVOKED_TOPIC, (e) => this.sessionsRevokedSubject.next(e));
    this.bus?.subscribe(SESSION_IDS_REVOKED_TOPIC, (e) => this.sessionIdsRevokedSubject.next(e));
  }

  publishNotification(event: RealtimeNotificationEvent): void {
    this.notificationsSubject.next(event);
    this.bus?.publish(NOTIFICATION_TOPIC, event);
  }

  publishPush(event: RealtimePushFanout): void {
    if (event.userIds.length === 0) return;
    this.pushesSubject.next(event);
    this.bus?.publish(PUSH_TOPIC, event);
  }

  publishSessionIdsRevoked(userId: string, sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    this.sessionIdsRevokedSubject.next({ userId, sessionIds });
    this.bus?.publish(SESSION_IDS_REVOKED_TOPIC, { userId, sessionIds });
  }

  publishSessionsRevoked(userIds: string[]): void {
    if (userIds.length === 0) return;
    this.sessionsRevokedSubject.next({ userIds });
    this.bus?.publish(SESSIONS_REVOKED_TOPIC, { userIds });
  }
}
