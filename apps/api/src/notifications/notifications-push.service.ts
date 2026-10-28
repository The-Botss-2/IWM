import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  type DesktopPushPayload,
  isAllowedPushEndpoint,
  type RegisterPushDeviceInput,
  type SubscribePushInput,
} from '@botss/shared-types';
import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import * as webpush from 'web-push';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from './realtime-events.service';

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function ownedElsewhere(): ConflictException {
  return new ConflictException({
    title: 'Registered to another account',
    status: 409,
    detail:
      'This device is still registered for another account. Sign that account out on the device first.',
    code: 'push-target-owned',
  });
}

/**
 * Native OS Web Push integration. Stores per-device subscriptions
 * (FCM/APNS/Mozilla endpoints) and fans pushes out via VAPID-signed
 * `webpush.sendNotification`. Every send also goes to the native mobile
 * devices (Expo) and, live, to the users' connected sockets
 * (`RealtimeEventsService.publishPush` -> `os_notification`, which the
 * desktop app banners from). Those two legs never depend on VAPID.
 *
 * Auto-prune contract: any push that returns 404 or 410 is treated as
 * a permanent endpoint death (browser uninstalled, push service
 * deprovisioned) and the offending row is dropped from the DB so we
 * never retry against a dead subscription.
 *
 * Operational requirements (env):
 *   VAPID_SUBJECT       - `mailto:` URL the push services use to
 *                         contact your team if abuse is reported.
 *   VAPID_PUBLIC_KEY    - base64-url-encoded public half of the keypair.
 *   VAPID_PRIVATE_KEY   - base64-url-encoded private half. Never leaves
 *                         the API process.
 *
 * If any of these are missing at boot, the service still constructs (so
 * tests / dev environments without push enabled aren't blocked) but
 * the Web Push leg of `sendDesktopNotification` becomes a no-op + warns once.
 */
@Injectable()
export class NotificationsPushService {
  private readonly logger = new Logger(NotificationsPushService.name);
  private readonly enabled: boolean;
  private warnedDisabledOnce = false;
  // Native push (Expo -> FCM/APNs). No server credential needed to send;
  // EXPO_ACCESS_TOKEN only raises rate limits. The project's FCM/APNs creds
  // live in EAS, not here. Reaches a fully closed app, unlike Web Push.
  private readonly expo = new Expo(
    process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : undefined,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
  ) {
    const subject = process.env.VAPID_SUBJECT;
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;

    if (subject && publicKey && privateKey) {
      try {
        webpush.setVapidDetails(subject, publicKey, privateKey);
        this.enabled = true;
        this.logger.log('Web Push enabled (VAPID configured).');
      } catch (err) {
        this.enabled = false;
        this.logger.error(
          `Web Push disabled - VAPID configuration rejected: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    } else {
      this.enabled = false;
      this.logger.warn(
        'Web Push disabled - VAPID_SUBJECT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not all set.',
      );
    }
  }

  /**
   * Upsert by endpoint so re-subscriptions from the same device dedupe.
   *
   * An endpoint already registered to ANOTHER user is only moved to the
   * caller when the request carries that subscription's own keys (the same
   * browser, now signed in as someone else). Knowing an endpoint URL alone
   * must not let anyone redirect another person's notifications to their
   * own account or silence that person's device.
   */
  async subscribe(userId: string, input: SubscribePushInput): Promise<{ ok: true }> {
    if (!isAllowedPushEndpoint(input.endpoint)) {
      throw new BadRequestException({
        title: 'Unsupported push endpoint',
        status: 400,
        detail: 'Push subscriptions must use a known Web Push service over https.',
      });
    }
    const existing = await this.prisma.client.userNotificationSubscription.findUnique({
      where: { endpoint: input.endpoint },
      select: { id: true, userId: true, auth: true, p256dh: true },
    });
    if (existing && existing.userId !== userId) {
      const sameSubscription =
        safeEqual(existing.auth, input.auth) && safeEqual(existing.p256dh, input.p256dh);
      if (!sameSubscription) throw ownedElsewhere();
    }
    await this.prisma.client.userNotificationSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId,
        endpoint: input.endpoint,
        auth: input.auth,
        p256dh: input.p256dh,
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId,
        auth: input.auth,
        p256dh: input.p256dh,
        userAgent: input.userAgent ?? null,
      },
    });
    return { ok: true };
  }

  /** Remove a subscription explicitly (sign-out / device cleanup). */
  async unsubscribe(userId: string, endpoint: string): Promise<{ ok: true }> {
    await this.prisma.client.userNotificationSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return { ok: true };
  }

  /**
   * Fan-out a notification to every device the user has registered.
   * Parallel sends, independent error handling per device - one dead
   * endpoint never blocks the others. Returns the count of *successful*
   * deliveries so callers can log without crawling individual results.
   */
  async sendDesktopNotification(
    userId: string,
    payload: DesktopPushPayload,
  ): Promise<{ sent: number; dropped: number }> {
    return this.sendDesktopNotificationToUsers([userId], payload);
  }

  /**
   * The same notification to several users at once (chat fan-out): ONE
   * subscription lookup and ONE device lookup for all of them, and the
   * native pushes go out as one chunked Expo request instead of one per
   * user. Per-device behaviour (TTL, 404/410 and DeviceNotRegistered
   * pruning, error isolation) is exactly `sendDesktopNotification`'s - that
   * method is this one with a single user.
   */
  async sendDesktopNotificationToUsers(
    userIds: readonly string[],
    payload: DesktopPushPayload,
  ): Promise<{ sent: number; dropped: number }> {
    const ids = Array.from(new Set(userIds));
    if (ids.length === 0) return { sent: 0, dropped: 0 };
    const who = ids.length === 1 ? `userId=${ids[0]}` : `users=${ids.length}`;
    // Live leg: the same payload to the users' connected sockets, which is
    // how the desktop app raises its banners (Electron has no push service).
    // Published here so it fires for exactly the events phones get a push
    // for, and before the VAPID check so it never depends on push config.
    // Isolated so a socket problem can never cost the phones their push.
    try {
      this.realtime.publishPush({ userIds: ids, payload: { ...payload, pushId: randomUUID() } });
    } catch (err) {
      this.logger.warn(`live push fan-out failed ${who}: ${(err as Error)?.message ?? 'unknown'}`);
    }
    // Native mobile push is independent of Web Push/VAPID and reaches a fully
    // closed app, so always attempt it - even when VAPID isn't configured.
    // Fire-and-forget: a native failure must not affect the web-push result.
    void this.sendNativePush(ids, payload).catch((err) => {
      this.logger.warn(
        `native push fan-out failed ${who}: ${(err as Error)?.message ?? 'unknown'}`,
      );
    });

    if (!this.enabled) {
      if (!this.warnedDisabledOnce) {
        this.warnedDisabledOnce = true;
        this.logger.warn('sendDesktopNotification called but Web Push is disabled - skipping.');
      }
      return { sent: 0, dropped: 0 };
    }

    const subs = await this.prisma.client.userNotificationSubscription.findMany({
      where: ids.length === 1 ? { userId: ids[0] } : { userId: { in: ids } },
      select: { id: true, userId: true, endpoint: true, auth: true, p256dh: true },
    });
    if (subs.length === 0) return { sent: 0, dropped: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    let dropped = 0;

    await Promise.all(
      subs.map(async (sub) => {
        // Re-check before the server makes the request: rows stored before
        // the allowlist existed may point anywhere (SSRF). Drop them.
        if (!isAllowedPushEndpoint(sub.endpoint)) {
          dropped += 1;
          this.logger.warn(`Dropping push subscription with a disallowed endpoint id=${sub.id}`);
          await this.prisma.client.userNotificationSubscription
            .delete({ where: { id: sub.id } })
            .catch(() => undefined);
          return;
        }
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { auth: sub.auth, p256dh: sub.p256dh },
            },
            body,
            { TTL: payload.type === 'call' ? 30 : 120 },
          );
          sent += 1;
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode;
          // 404 = endpoint not found, 410 = endpoint gone - both terminal.
          if (statusCode === 404 || statusCode === 410) {
            dropped += 1;
            await this.prisma.client.userNotificationSubscription
              .delete({ where: { id: sub.id } })
              .catch((cleanupErr) => {
                this.logger.warn(
                  `Failed to prune dead push endpoint id=${sub.id}: ${(cleanupErr as Error)?.message ?? 'unknown'}`,
                );
              });
          } else {
            this.logger.warn(
              `Push send failed userId=${sub.userId} subId=${sub.id} status=${statusCode ?? 'unknown'} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          }
        }
      }),
    );

    return { sent, dropped };
  }

  /** Register/refresh a native device token. Upsert by token so the same
   *  device reattaching dedupes in place. A token still registered to
   *  ANOTHER user is refused (409): the token is not a secret, and
   *  rebinding it would let anyone take over that person's device
   *  notifications. The mobile shell unregisters on sign-out, which frees
   *  the token for the next account on the device. */
  async registerDevice(userId: string, input: RegisterPushDeviceInput): Promise<{ ok: true }> {
    const existing = await this.prisma.client.userPushDevice.findUnique({
      where: { token: input.token },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) throw ownedElsewhere();
    await this.prisma.client.userPushDevice.upsert({
      where: { token: input.token },
      create: {
        userId,
        token: input.token,
        platform: input.platform,
        userAgent: input.userAgent ?? null,
      },
      update: {
        userId,
        platform: input.platform,
        userAgent: input.userAgent ?? null,
        lastSeenAt: new Date(),
      },
    });
    return { ok: true };
  }

  /** Drop a native device token (sign-out / permission revoked). */
  async unregisterDevice(userId: string, token: string): Promise<{ ok: true }> {
    await this.prisma.client.userPushDevice.deleteMany({
      where: { userId, token },
    });
    return { ok: true };
  }

  /**
   * Fan out a notification to the users' native devices via the Expo push API
   * (Expo routes to FCM/APNs). Delivered even when the app is fully closed.
   * Tokens Expo reports as DeviceNotRegistered are pruned, mirroring the
   * Web Push 404/410 contract. All users' devices share one chunked request.
   */
  private async sendNativePush(
    userIds: readonly string[],
    payload: DesktopPushPayload,
  ): Promise<void> {
    const who = userIds.length === 1 ? `userId=${userIds[0]}` : `users=${userIds.length}`;
    const devices = await this.prisma.client.userPushDevice.findMany({
      where: userIds.length === 1 ? { userId: userIds[0] } : { userId: { in: [...userIds] } },
      select: { id: true, token: true },
    });
    const valid = devices.filter((d) => Expo.isExpoPushToken(d.token));
    if (valid.length === 0) return;

    const messages: ExpoPushMessage[] = valid.map((d) => ({
      to: d.token,
      title: payload.title,
      body: payload.body,
      sound: 'default',
      // Calls ring with high priority on a dedicated channel; everything else
      // uses the default channel. Channels are created by the mobile shell.
      priority: payload.type === 'call' ? 'high' : 'default',
      channelId: payload.type === 'call' ? 'calls' : 'default',
      data: { url: payload.url, ...(payload.data ?? {}) },
    }));

    const chunks = this.expo.chunkPushNotifications(messages);
    let cursor = 0;
    for (const chunk of chunks) {
      try {
        const tickets = await this.expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < tickets.length; i += 1) {
          const ticket = tickets[i];
          const device = valid[cursor + i];
          if (!ticket || !device) continue;
          if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
            await this.prisma.client.userPushDevice
              .delete({ where: { id: device.id } })
              .catch((cleanupErr) => {
                this.logger.warn(
                  `Failed to prune dead push token id=${device.id}: ${(cleanupErr as Error)?.message ?? 'unknown'}`,
                );
              });
          }
        }
      } catch (err) {
        this.logger.warn(`Expo push chunk failed ${who}:${(err as Error)?.message ?? 'unknown'}`);
      }
      cursor += chunk.length;
    }
  }
}
