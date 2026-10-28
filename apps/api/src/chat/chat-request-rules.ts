import type { Prisma } from '@botss/database';
import type { OutgoingChatRequestState } from '@botss/shared-types';

/**
 * Pure rules for cross-organization chat requests, shared by
 * ChatRequestsService (send, list, decline) and ChatService (accept), so the
 * request a recipient can see is exactly the request they can accept.
 */

/** A request older than this stops showing up and may be sent again. Also the
 *  cool-down after a decline before the same person can be asked again. */
export const CHAT_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function chatRequestCutoff(now: Date): Date {
  return new Date(now.getTime() - CHAT_REQUEST_TTL_MS);
}

export interface ChatRequestViewer {
  id: string;
  email: string;
  organizationId: string;
  /** When the viewer's account was created. */
  createdAt: Date;
}

/**
 * A request only ever reaches an account that existed when it was sent. An
 * account created later for the same address (a new tenant's self-signup, or
 * an admin minting users in an unclaimed domain) never inherits requests that
 * were meant for whoever owned the address before.
 */
export function requestReachesAccount(sentAt: Date, accountCreatedAt: Date): boolean {
  return sentAt >= accountCreatedAt;
}

/**
 * The requests `viewer` may see and act on: addressed to their email, still
 * pending and fresh, sent after their account existed, from a live STAFF
 * account in another, active organization, and not from someone they
 * blocked. The soft-delete extension only filters top-level rows, so the
 * relation filters spell `deletedAt: null` out by hand.
 */
export function incomingRequestWhere(
  viewer: ChatRequestViewer,
  now: Date,
): Prisma.ChatRequestWhereInput {
  const cutoff = chatRequestCutoff(now);
  return {
    recipientEmail: viewer.email.toLowerCase(),
    status: 'PENDING',
    sentAt: { gte: viewer.createdAt > cutoff ? viewer.createdAt : cutoff },
    requesterId: { not: viewer.id },
    requester: {
      deletedAt: null,
      accountType: 'STAFF',
      AND: [{ organizationId: { not: null } }, { organizationId: { not: viewer.organizationId } }],
      organization: { isActive: true, deletedAt: null },
      chatRequestBlocksReceived: { none: { blockerId: viewer.id } },
    },
  };
}

interface RequestLifecycle {
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';
  sentAt: Date;
  respondedAt: Date | null;
}

/**
 * What a repeat send does to the existing row. The VISIBLE effect (does the
 * sender see a fresh "sent" request, or their earlier one) depends only on
 * what the sender can already see - accepted, cancelled, or a request still
 * inside its 30 days - so it never reveals a decline:
 *  - `bump`: accepted, or a request (pending or secretly declined) younger
 *    than 30 days; only the attempt count moves.
 *  - otherwise the request looks re-sent (new message, new sentAt). Whether it
 *    is really delivered depends on the decline cool-down:
 *    - `reopen`: back to PENDING and delivered again;
 *    - `quiet-reopen`: the recipient declined less than 30 days ago, so it
 *      stays DECLINED (respondedAt kept) and is not delivered. Cancelling and
 *      re-sending, or waiting out the request's own 30 days, therefore cannot
 *      skip the cool-down.
 */
export function repeatSendAction(
  row: RequestLifecycle,
  now: Date,
): 'reopen' | 'quiet-reopen' | 'bump' {
  const cutoff = chatRequestCutoff(now);
  if (row.status === 'ACCEPTED') return 'bump';
  if ((row.status === 'PENDING' || row.status === 'DECLINED') && row.sentAt >= cutoff) {
    return 'bump';
  }
  // respondedAt on a non-accepted row is always a decline (an accepted
  // request cannot be cancelled).
  return row.respondedAt && row.respondedAt >= cutoff ? 'quiet-reopen' : 'reopen';
}

/** The sender's view. A decline (and so a block) is never revealed: PENDING
 *  and DECLINED both read as SENT, or EXPIRED once 30 days old. */
export function outgoingState(
  row: Pick<RequestLifecycle, 'status' | 'sentAt'>,
  now: Date,
): OutgoingChatRequestState {
  if (row.status === 'ACCEPTED') return 'ACCEPTED';
  if (row.status === 'CANCELLED') return 'CANCELLED';
  return row.sentAt < chatRequestCutoff(now) ? 'EXPIRED' : 'SENT';
}
