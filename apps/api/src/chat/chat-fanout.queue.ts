/**
 * Post-send fan-out for a chat message (OS push + bell rows) runs on its own
 * queue so a large channel's fan-out never competes with the HTTP request
 * that sent the message.
 */
export const CHAT_FANOUT_QUEUE = 'chat-fanout';
export const CHAT_FANOUT_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CHAT_FANOUT_CONCURRENCY ?? '5', 10) || 5,
);

export interface ChatFanoutJobData {
  kind: 'message';
  roomId: string;
  senderUserId: string;
  content: string | null;
  mentionedUserIds: string[];
  /** The message being fanned out; rides on the push as `data.messageId`.
   *  Optional because jobs queued by an older build don't carry it. */
  messageId?: string;
}

/**
 * One attempt, like the in-process fan-out it replaces: a retry after a
 * partial success would push / bell the same recipients twice.
 */
export const CHAT_FANOUT_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 60 * 60 * 24, count: 1000 },
} as const;
