import { z } from 'zod';

import { cuid } from './common/id.js';

/**
 * Push services a browser subscription may point at. The API POSTs to the
 * stored endpoint, so an arbitrary URL would let any signed-in user make the
 * server call internal hosts (SSRF). Exact hosts, plus subdomains of the
 * suffixes (Mozilla, Windows WNS and Apple shard their endpoints).
 */
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com'];

/** True for an https URL on a known Web Push service, default port only. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Web Push subscription payload as it arrives from the browser's
 * `PushManager.subscribe()` JSON. The keys live inside a nested object
 * in the browser API; we flatten them server-side for storage.
 */
export const subscribePushSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2048)
    .refine(isAllowedPushEndpoint, 'Unsupported push service endpoint.'),
  /// VAPID auth secret (base64-url-encoded).
  auth: z.string().min(1).max(512),
  /// VAPID p256dh public key (base64-url-encoded).
  p256dh: z.string().min(1).max(512),
  userAgent: z.string().max(512).optional(),
});
export type SubscribePushInput = z.infer<typeof subscribePushSchema>;

/** Native mobile push platforms. Free-form 'expo' covers Expo push tokens
 *  (ExponentPushToken[...]) which the server routes through the Expo push API. */
export const pushPlatformSchema = z.enum(['android', 'ios', 'expo']);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

/**
 * Native device registration for OS push (FCM/APNs via Expo). Unlike Web Push
 * this is a single opaque token - no endpoint/keys - so the OS can deliver to a
 * fully closed app. Sent by the mobile shell after the WebView session resolves.
 */
export const registerPushDeviceSchema = z.object({
  token: z.string().min(1).max(512),
  platform: pushPlatformSchema,
  userAgent: z.string().max(512).optional(),
});
export type RegisterPushDeviceInput = z.infer<typeof registerPushDeviceSchema>;

/** Drop a native device token (sign-out / permission revoked). */
export const unregisterPushDeviceSchema = z.object({
  token: z.string().min(1).max(512),
});
export type UnregisterPushDeviceInput = z.infer<
  typeof unregisterPushDeviceSchema
>;

export const userNotificationSubscriptionSchema = z.object({
  id: cuid,
  userId: cuid,
  endpoint: z.string().url(),
  auth: z.string(),
  p256dh: z.string(),
  userAgent: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type UserNotificationSubscription = z.infer<
  typeof userNotificationSubscriptionSchema
>;

/**
 * Server-side payload sent through web-push to a browser. Mirrored
 * 1:1 by the service-worker `push` handler's parser.
 */
export const desktopPushPayloadSchema = z.object({
  title: z.string().max(120),
  body: z.string().max(400),
  /// Routes the SW's stickiness + audio escalation logic.
  type: z.enum(['message', 'call', 'generic']),
  /// Deep-link target for `notificationclick`.
  url: z.string().min(1).max(2048),
  /// Notification.tag - collapses repeated banners on the same target.
  tag: z.string().max(120).optional(),
  /// Free-form structured metadata the SW can forward back via postMessage.
  data: z.record(z.unknown()).optional(),
});
export type DesktopPushPayload = z.infer<typeof desktopPushPayloadSchema>;

/**
 * The chat socket's `os_notification` event: the exact payload a phone gets
 * as a native push, delivered live to the user's connected clients. The
 * desktop app raises its OS banner from this, so it pops up for the same
 * events as mobile. `pushId` is unique per send and lets a client drop a
 * repeat.
 */
export const realtimePushEventSchema = desktopPushPayloadSchema.extend({
  pushId: z.string().min(1).max(64),
});
export type RealtimePushEvent = z.infer<typeof realtimePushEventSchema>;

/** Advertised in the chat socket's `connected` event by a server that emits
 *  `os_notification`. Clients keep their older banner paths without it. */
export const OS_NOTIFICATION_SOCKET_FEATURE = 'os_notification';
