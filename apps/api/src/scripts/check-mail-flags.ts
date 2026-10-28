/**
 * Mail flag reconcile rules (mail-flag-reconcile.ts), no mail server needed:
 * a read/star change the server never confirmed is re-sent rather than
 * undone, while changes made in other apps still flow in. Read and star are
 * pending separately, so one never re-sends the other.
 *
 * Run: pnpm --filter @botss/api test (chained after the mail governor check).
 */
import assert from 'node:assert/strict';

import {
  decideFlags,
  type FlagDecision,
  type LocalFlags,
  PENDING_FLAG_MAX_AGE_MS,
  serverFlagsOf,
} from '../mail/mail-flag-reconcile';

const GRACE = 60_000;
const now = Date.parse('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(now - ms);
const fiveMin = ago(5 * 60_000);
const local = (over: Partial<LocalFlags> = {}): LocalFlags => ({
  isUnread: false,
  isStarred: false,
  isAnswered: false,
  updatedAt: ago(10 * 60_000),
  seenPendingAt: null,
  starredPendingAt: null,
  ...over,
});
const update = (over: Partial<Extract<FlagDecision, { kind: 'update' }>>): FlagDecision => ({
  kind: 'update',
  adopt: {},
  clearSeen: false,
  clearStarred: false,
  repushSeen: null,
  repushFlagged: null,
  ...over,
});
const decide = (row: LocalFlags, flags: string[]) =>
  decideFlags(row, serverFlagsOf(flags), now, GRACE);

function main(): void {
  assert.deepEqual(serverFlagsOf(['\\Seen', '\\Flagged', '\\Answered']), {
    isUnread: false,
    isStarred: true,
    isAnswered: true,
  });

  // The reported bug: marked read here, the STORE failed, server still unread.
  assert.deepEqual(
    decide(local({ seenPendingAt: fiveMin }), []),
    update({ repushSeen: true }),
    'an unconfirmed read is re-sent, not undone',
  );
  assert.deepEqual(
    decide(
      local({ isUnread: true, isStarred: true, seenPendingAt: fiveMin, starredPendingAt: fiveMin }),
      ['\\Seen'],
    ),
    update({ repushSeen: false, repushFlagged: true }),
    'unread + star both re-sent',
  );

  // Server caught up: drop the marker.
  assert.deepEqual(
    decide(local({ seenPendingAt: fiveMin }), ['\\Seen']),
    update({ clearSeen: true }),
    'confirmed read clears its marker',
  );

  // Without a pending change the server wins: read on the phone, or marked
  // unread in webmail, shows up here.
  assert.deepEqual(
    decide(local({ isUnread: true }), ['\\Seen']),
    update({ adopt: { isUnread: false } }),
    'read elsewhere',
  );
  assert.deepEqual(
    decide(local(), []),
    update({ adopt: { isUnread: true } }),
    'marked unread elsewhere',
  );

  // One flag pending never re-sends the other.
  assert.deepEqual(
    decide(local({ isUnread: true, isStarred: true, starredPendingAt: fiveMin }), ['\\Seen']),
    update({ adopt: { isUnread: false }, repushFlagged: true }),
    'star pending + read on phone: adopt read, re-send only the star',
  );
  assert.deepEqual(
    decide(local({ isStarred: true, seenPendingAt: fiveMin }), []),
    update({ adopt: { isStarred: false }, repushSeen: true }),
    'read pending + unstarred on phone: adopt unstar, re-send only the read',
  );

  // A click from seconds ago is never touched.
  assert.deepEqual(
    decide(local({ updatedAt: ago(5_000), seenPendingAt: ago(5_000) }), []),
    { kind: 'keep' },
    'grace window',
  );
  assert.deepEqual(decide(local(), ['\\Seen']), { kind: 'keep' }, 'nothing differs');

  // A change the server never took for a week gives way to the server.
  assert.deepEqual(
    decide(local({ seenPendingAt: ago(PENDING_FLAG_MAX_AGE_MS + 1) }), []),
    update({ adopt: { isUnread: true }, clearSeen: true }),
    'expired pending read',
  );

  // \Answered always comes from the server.
  assert.deepEqual(
    decide(local({ seenPendingAt: fiveMin }), ['\\Seen', '\\Answered']),
    update({ adopt: { isAnswered: true }, clearSeen: true }),
    'answered comes from the server',
  );

  console.log('mail flag checks passed');
}

main();
