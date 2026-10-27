import { z } from 'zod';

import { cuid } from '../common/id.js';
import { userSummarySchema } from '../user.js';

/**
 * Cross-organization chat requests. Someone types an email address and a
 * short message; if that address belongs to a staff member at another
 * organization, they see the request and can accept it (which opens a DM),
 * decline it, or decline and block the sender.
 *
 * Enumeration safety: the send response is identical whether or not the
 * address belongs to anyone, and the sender never learns about a decline or
 * a block. Every outgoing request reads as "sent" until it is accepted.
 */

export const CHAT_REQUEST_MESSAGE_MAX = 500;

/** The one thing the sender is ever told after sending, for any address. */
export const CHAT_REQUEST_SENT_NOTICE = "If they use the CRM, they'll get your request";

/** Mirrors the Prisma `ChatRequestStatus` enum. Server-side only on the wire
 *  for the recipient; the sender sees `outgoingChatRequestState` instead. */
export const chatRequestStatus = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED']);
export type ChatRequestStatus = z.infer<typeof chatRequestStatus>;

export const createChatRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  message: z.string().trim().min(1).max(CHAT_REQUEST_MESSAGE_MAX),
});
export type CreateChatRequestInput = z.infer<typeof createChatRequestSchema>;

/**
 * What the sender sees. PENDING and DECLINED both read as SENT (EXPIRED once
 * older than 30 days) so a decline or block is never revealed.
 */
export const outgoingChatRequestState = z.enum(['SENT', 'ACCEPTED', 'EXPIRED', 'CANCELLED']);
export type OutgoingChatRequestState = z.infer<typeof outgoingChatRequestState>;

export const outgoingChatRequestSchema = z.object({
  id: cuid,
  email: z.string(),
  message: z.string(),
  sentAt: z.coerce.date(),
  state: outgoingChatRequestState,
  /** The DM it opened; only set once accepted. */
  roomId: cuid.nullable(),
});
export type OutgoingChatRequest = z.infer<typeof outgoingChatRequestSchema>;

export const chatRequestSentResponseSchema = z.object({
  notice: z.literal(CHAT_REQUEST_SENT_NOTICE),
  request: outgoingChatRequestSchema,
});
export type ChatRequestSentResponse = z.infer<typeof chatRequestSentResponseSchema>;

export const outgoingChatRequestListSchema = z.object({
  items: z.array(outgoingChatRequestSchema),
});
export type OutgoingChatRequestList = z.infer<typeof outgoingChatRequestListSchema>;

/** The requester as the recipient sees them. The organization's NAME only -
 *  never its id. */
export const chatRequestRequesterSchema = userSummarySchema.extend({
  organizationName: z.string().nullable(),
});
export type ChatRequestRequester = z.infer<typeof chatRequestRequesterSchema>;

export const incomingChatRequestSchema = z.object({
  id: cuid,
  message: z.string(),
  sentAt: z.coerce.date(),
  requester: chatRequestRequesterSchema,
});
export type IncomingChatRequest = z.infer<typeof incomingChatRequestSchema>;

export const incomingChatRequestListSchema = z.object({
  items: z.array(incomingChatRequestSchema),
});
export type IncomingChatRequestList = z.infer<typeof incomingChatRequestListSchema>;

export const declineChatRequestSchema = z.object({
  /** Also block the requester: hides every request from them, now and later. */
  block: z.boolean().default(false),
});
export type DeclineChatRequestInput = z.infer<typeof declineChatRequestSchema>;

/** Block someone you share a cross-organization DM with (the DM header's
 *  "Block"). Same effect as "Decline & block" on a request. */
export const blockChatUserSchema = z.object({ userId: cuid });
export type BlockChatUserInput = z.infer<typeof blockChatUserSchema>;

export const chatRequestOkSchema = z.object({ ok: z.literal(true) });
export type ChatRequestOk = z.infer<typeof chatRequestOkSchema>;

export const chatRequestBlockSchema = z.object({
  user: userSummarySchema,
  blockedAt: z.coerce.date(),
});
export type ChatRequestBlock = z.infer<typeof chatRequestBlockSchema>;

export const chatRequestBlockListSchema = z.object({
  items: z.array(chatRequestBlockSchema),
});
export type ChatRequestBlockList = z.infer<typeof chatRequestBlockListSchema>;
