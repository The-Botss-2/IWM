/**
 * What the flag reconcile pass does with one message, as a pure function so
 * check-mail-flags.ts can cover every case without a mail server.
 *
 * The rule that matters: a read (or star) change made here that the mail
 * server has not confirmed is re-sent, never overwritten by the server's
 * older state. Before this, a STORE that failed (host busy, connection
 * timeout, governor backoff, or imapflow quietly returning false) was at
 * best logged, and the next reconcile copied the server's "unread" back over
 * the user's click.
 *
 * Read and star are pending separately (`seenPendingAt`, `starredPendingAt`),
 * so a pending star never re-sends a read state the user changed elsewhere.
 */

/** A pending change older than this gives way to the server. */
export const PENDING_FLAG_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface LocalFlags {
  isUnread: boolean;
  isStarred: boolean;
  isAnswered: boolean;
  updatedAt: Date;
  seenPendingAt: Date | null;
  starredPendingAt: Date | null;
}

export interface ServerFlags {
  isUnread: boolean;
  isStarred: boolean;
  isAnswered: boolean;
}

export type FlagDecision =
  /** Leave the row alone (a very recent local write, or nothing to do). */
  | { kind: 'keep' }
  | {
      kind: 'update';
      /** Server values to write locally (only the ones that differ). */
      adopt: Partial<ServerFlags>;
      /** Drop a confirmed or expired marker. */
      clearSeen: boolean;
      clearStarred: boolean;
      /** Our value to send the server again, or null for nothing to send. */
      repushSeen: boolean | null;
      repushFlagged: boolean | null;
    };

export function serverFlagsOf(flags: string[]): ServerFlags {
  return {
    isUnread: !flags.includes('\\Seen'),
    isStarred: flags.includes('\\Flagged'),
    isAnswered: flags.includes('\\Answered'),
  };
}

export function decideFlags(
  row: LocalFlags,
  server: ServerFlags,
  now: number,
  graceMs: number,
): FlagDecision {
  // Our own very recent write wins outright: the STORE may still be in flight.
  if (now - row.updatedAt.getTime() < graceMs) return { kind: 'keep' };

  const live = (at: Date | null) => at !== null && now - at.getTime() < PENDING_FLAG_MAX_AGE_MS;
  const adopt: Partial<ServerFlags> = {};
  let clearSeen = false;
  let clearStarred = false;
  let repushSeen: boolean | null = null;
  let repushFlagged: boolean | null = null;

  if (server.isUnread !== row.isUnread) {
    if (live(row.seenPendingAt)) repushSeen = !row.isUnread;
    else adopt.isUnread = server.isUnread;
  }
  // Confirmed (server agrees) or expired: either way the marker is done.
  if (row.seenPendingAt !== null && repushSeen === null) clearSeen = true;

  if (server.isStarred !== row.isStarred) {
    if (live(row.starredPendingAt)) repushFlagged = row.isStarred;
    else adopt.isStarred = server.isStarred;
  }
  if (row.starredPendingAt !== null && repushFlagged === null) clearStarred = true;

  if (server.isAnswered !== row.isAnswered) adopt.isAnswered = server.isAnswered;

  if (
    Object.keys(adopt).length === 0 &&
    !clearSeen &&
    !clearStarred &&
    repushSeen === null &&
    repushFlagged === null
  ) {
    return { kind: 'keep' };
  }
  return { kind: 'update', adopt, clearSeen, clearStarred, repushSeen, repushFlagged };
}
