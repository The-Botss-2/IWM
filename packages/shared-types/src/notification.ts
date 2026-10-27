import { z } from 'zod';

import { cuid } from './common/id.js';
import { userSummarySchema } from './user.js';

// Keep in lock-step with the Prisma `NotificationType` enum
// (packages/database/prisma/schema.prisma). Append-only.
export const notificationType = z.enum([
  'TASK_COMMENT',
  'TASK_ASSIGNED',
  'MAIL_RECEIVED',
  'CHAT_MESSAGE',
  'MENTION',
  'TODO_ASSIGNED',
  'TASK_COMPLETED',
  'TASK_IN_REVIEW',
  'PROJECT_ADDED',
  'LEAD_ASSIGNED',
  'CLIENT_ASSIGNED',
  'LEAVE_DECISION',
  'TIMESHEET_WARNING',
  'SPRINT_STARTED',
  'GOAL_ASSIGNED',
  'CALL_MISSED',
  'INVOICE_UPDATE',
  'DOCUMENT_SHARED',
  'INVITE_ACCEPTED',
  'LEAD_FOLLOWUP_DUE',
  'PAYMENT_RECEIVED',
  'MILESTONE_DELIVERED',
  'SIGNATURE_SIGNED',
  'SIGNATURE_COMPLETED',
  'SIGNATURE_DECLINED',
  'CHAT_REQUEST',
]);
export type NotificationType = z.infer<typeof notificationType>;

/** Entity kinds a notification can point at, for deep-linking + the
 *  contextual auto-read sweep (open the entity -> its notifications clear). */
export const notificationEntityType = z.enum([
  'mail',
  'chat',
  'task',
  'todo',
  'project',
  'lead',
  'client',
  'comment',
  'leave',
  'timesheet',
  'sprint',
  'goal',
  'call',
  'invoice',
  'document',
  'invitation',
  'contract',
  'signature',
  'chat_request',
]);
export type NotificationEntityType = z.infer<typeof notificationEntityType>;

export const notificationSchema = z.object({
  id: cuid,
  userId: cuid,
  actorId: cuid.nullable(),
  type: notificationType,
  title: z.string(),
  body: z.string(),
  taskId: cuid.nullable(),
  commentId: cuid.nullable(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  url: z.string().nullable(),
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  actor: userSummarySchema.nullable(),
});
export type Notification = z.infer<typeof notificationSchema>;

/** Body for POST /notifications/read-by-entity - clears every unread
 *  notification the caller has for a given entity (used on open/view). */
export const markReadByEntitySchema = z.object({
  entityType: notificationEntityType,
  entityId: z.string().min(1).max(64),
});
export type MarkReadByEntityInput = z.infer<typeof markReadByEntitySchema>;

export const listNotificationsQuerySchema = z.object({
  unreadOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationListResponseSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;
