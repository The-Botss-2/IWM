import { z } from 'zod';
import {
  type ListNotificationsQuery,
  type MarkReadByEntityInput,
  notificationListResponseSchema,
  type RegisterPushDeviceInput,
  type SubscribePushInput,
} from '@botss/shared-types';

import type { HttpClient } from '../client.js';

const okSchema = z.object({ ok: z.boolean() });
const subscribeOkSchema = z.object({ ok: z.literal(true) });

export class NotificationsResource {
  constructor(private readonly http: HttpClient) {}

  list(query?: Partial<ListNotificationsQuery>) {
    return this.http.get('/notifications', notificationListResponseSchema, query);
  }
  markRead(id: string) {
    return this.http.post(`/notifications/${id}/read`, okSchema, {});
  }
  markAllRead() {
    return this.http.post('/notifications/read-all', okSchema, {});
  }

  /** Clear unread notifications for an entity the user just opened. */
  markReadByEntity(input: MarkReadByEntityInput) {
    return this.http.post('/notifications/read-by-entity', okSchema, input);
  }

  /** Register the current browser/device for Web Push notifications. */
  subscribePush(input: SubscribePushInput) {
    return this.http.post('/notifications/subscribe', subscribeOkSchema, input);
  }

  /** Register a native mobile device token (Expo/FCM) for OS push that reaches
   *  a fully closed app. Called by the web app once the mobile shell hands it
   *  the token over the WebView bridge. */
  registerPushDevice(input: RegisterPushDeviceInput) {
    return this.http.post('/notifications/devices', subscribeOkSchema, input);
  }

  /** Drop a native device token (sign-out / permission revoked). */
  unregisterPushDevice(token: string) {
    return this.http.delete('/notifications/devices', okSchema, { token });
  }
}
