import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type MailAccount, type MailFolder } from '@botss/database';
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';

import { MailCryptoService } from './mail-crypto.service';
import { decideFlags, serverFlagsOf } from './mail-flag-reconcile';
import { MailHostGovernor } from './mail-host-governor';
import { resolvePublicHost } from './mail-ssrf';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Pooled per-account IMAP connection. We hold one open for as long as the
 * account is being actively synced, closing it after POOL_IDLE_TIMEOUT_MS
 * of inactivity. Without pooling, every poll tick opens a fresh login (2+
 * per `syncAccount` call: one for `syncFolders`, one for
 * `syncFolderMessages`). cPanel/CSF rate-limits IMAP logins and bans the
 * source IP once the threshold is hit - that's exactly the failure mode
 * the hosting provider flagged. Pooling cuts the steady-state login rate
 * by an order of magnitude.
 */
interface PooledConnection {
  client: ImapFlow;
  /** Concurrent users of this connection. We only schedule the idle-close
   *  timer when the count drops to zero. Without this, two concurrent
   *  syncs against the same account would race on `logout()`. */
  refCount: number;
  /** Pending idle-close timer. Cleared whenever the connection is leased
   *  again before it fires. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** True while a connect() is in flight. Other callers awaiting the
   *  same account piggy-back on the same promise rather than triggering
   *  their own login. */
  connecting: Promise<ImapFlow> | null;
}

/**
 * The IDLE watcher's hold on an account's pooled connection. A pinned
 * connection is never idle-closed, parks on INBOX whenever nobody is using
 * it, and reports INBOX changes back to the watcher. One login per mailbox
 * then serves real-time push, syncs, sends and flag changes.
 */
export interface PinHandlers {
  inboxPath: string;
  onExists: () => void;
  onExpunge: () => void;
  /** The pinned connection closed. The watcher reconnects on its own clock. */
  onClose: () => void;
  /** Set when the watcher stops, so a login still in flight never pins. */
  cancelled?: boolean;
}

interface PinState {
  handlers: PinHandlers;
  client: ImapFlow | null;
  /** INBOX message count last time we saw INBOX selected. */
  inboxExists: number | null;
  /** INBOX UIDNEXT at the same point. Catches an arrival plus an expunge
   *  that leave the count unchanged. */
  inboxUidNext: number | null;
}

interface FolderSyncResult {
  totalFolders: number;
  inboxId: string | null;
}

interface MessageSyncResult {
  inserted: number;
  updated: number;
}

/** Text bodies pulled part-by-part for a message too large to fetch whole. */
interface TextBodies {
  text: string | null;
  html: string | null;
}

function intFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Most messages one sync run will import. Anything beyond continues in a
 *  follow-up run, so an interactive refresh never waits on a huge backlog. */
const INITIAL_FETCH_LIMIT = intFromEnv('MAIL_INITIAL_SYNC_LIMIT', 200);
/** Messages fetched and saved per round trip. Bounds memory and makes every
 *  round trip short enough to finish well inside the socket timeout. */
const SYNC_BATCH = intFromEnv('MAIL_SYNC_BATCH', 25);
/** Messages larger than this are imported without downloading their full
 *  source (attachments included); only their text parts are fetched. */
const MAX_SOURCE_BYTES = intFromEnv('MAIL_MAX_SOURCE_BYTES', 15 * 1024 * 1024);

/**
 * How many of a folder's most recent local messages get their IMAP flags
 * re-read on each sync. The message import is forward-only (UIDs past the
 * stored cursor), so without this pass a message read, starred or deleted in
 * webmail / on a phone never reconciles and the unread badge drifts upward
 * forever. A flags-only FETCH carries no bodies, so the window can be
 * generous without adding meaningful load.
 */
const FLAG_RECONCILE_WINDOW = intFromEnv('MAIL_FLAG_RECONCILE_WINDOW', 500);
/** Minimum gap between flag reconciliations for the same folder. */
const FLAG_RECONCILE_INTERVAL_MS = intFromEnv(
  'MAIL_FLAG_RECONCILE_INTERVAL_MS',
  60_000,
);
/**
 * A local flag write younger than this wins over whatever IMAP reports.
 * Covers two cases: the server has not yet reflected the STORE we just
 * issued, and the STORE failed outright but we kept the local state so the
 * user's "mark as read" still stuck. Without the grace window the reconcile
 * pass would immediately undo the click.
 */
const LOCAL_FLAG_GRACE_MS = 60_000;

/**
 * IMAP sync. Connects per-call using the account's decrypted password,
 * snapshots the folder list, then fetches recent messages into the database.
 * No long-lived connection pool yet - each sync opens a fresh imapflow
 * session and tears it down. IDLE / persistent connections land in Phase 3.
 */
@Injectable()
export class ImapSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(ImapSyncService.name);

  /** Connection pool keyed by accountId. Each entry holds at most one
   *  ImapFlow client. Reference-counted so concurrent callers share. */
  private readonly pool = new Map<string, PooledConnection>();
  /** Idle TTL - close the pooled client after this many ms with no users.
   *  4 min is below Dovecot's default 30 min server-side idle drop, so
   *  the connection stays alive long enough to soak up rapid-fire polling
   *  but doesn't sit forever after the user closes the mail tab. */
  private static readonly POOL_IDLE_TIMEOUT_MS = 4 * 60 * 1000;

  /** Accounts whose pooled connection the IDLE watcher holds open. */
  private readonly pins = new Map<string, PinState>();
  /** Mail server address each account last connected to (governor key). */
  private readonly hostKeys = new Map<string, string>();
  private destroyed = false;

  /**
   * In-flight sync per folder. Concurrent callers (IDLE push, page poll,
   * manual refresh, self-send retry, backstop poll) join the running sync
   * instead of racing on the same cursor and double-downloading the range.
   * A caller that arrives mid-run gets one follow-up run, so mail that landed
   * after the running sync listed its UIDs is never missed.
   */
  private readonly folderSyncs = new Map<
    string,
    { running: Promise<MessageSyncResult>; followUp: Promise<MessageSyncResult> | null }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailCryptoService,
    private readonly notifications: NotificationsService,
    private readonly governor: MailHostGovernor,
  ) {}

  async onModuleDestroy(): Promise<void> {
    // Closing the pool below fires 'close' on pinned connections; watchers
    // must not read that as a drop and reconnect during shutdown.
    this.destroyed = true;
    this.pins.clear();
    // Drain the pool on shutdown so we leave the server cleanly. Without
    // this, the IMAP server holds the slot until its idle timer fires.
    const entries = Array.from(this.pool.entries());
    this.pool.clear();
    await Promise.allSettled(
      entries.map(async ([, conn]) => {
        if (conn.idleTimer) clearTimeout(conn.idleTimer);
        try {
          await conn.client.logout();
        } catch {
          /* connection might be dead - fine, we're shutting down. */
        }
      }),
    );
  }

  /**
   * Lease a pooled IMAP client for a single operation. Caller MUST call
   * `releaseClient(accountId)` in a `finally` block. Reference-counts so
   * concurrent leases on the same account share the same socket; the
   * idle-close timer is (re-)scheduled when the last lease releases.
   *
   * If the cached client is dead (server dropped the socket, NOOP fails),
   * we transparently re-connect once.
   */
  private async acquireClient(account: MailAccount): Promise<ImapFlow> {
    let entry = this.pool.get(account.id);
    if (!entry) {
      entry = { client: null as unknown as ImapFlow, refCount: 0, idleTimer: null, connecting: null };
      this.pool.set(account.id, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    // Another caller is already mid-connect for this account - wait for them.
    if (entry.connecting) {
      const client = await entry.connecting;
      // Evicted mid-connect: the originator logs the orphan out.
      if (this.pool.get(account.id) !== entry) throw this.connectionResetError();
      entry.refCount++;
      return client;
    }
    if (entry.client && entry.client.usable) {
      // Cheap liveness check. If NOOP fails we fall through to reconnect.
      try {
        await entry.client.noop();
        entry.refCount++;
        return entry.client;
      } catch (err) {
        this.logger.warn(
          `Pooled IMAP NOOP failed accountId=${account.id} - reconnecting. message=${(err as Error)?.message ?? 'unknown'}`,
        );
        try {
          await entry.client.logout();
        } catch {
          /* dead socket, nothing to log out */
        }
        entry.client = null as unknown as ImapFlow;
      }
    }
    // Fresh login. The governor refuses fast while this account or its host
    // is backing off. Stash the promise so concurrent callers join us instead
    // of opening their own connection (which would defeat the pool).
    if (this.destroyed) {
      throw new ServiceUnavailableException({ title: 'Mail service stopping', status: 503 });
    }
    entry.connecting = this.connect(account);
    try {
      const client = await entry.connecting;
      // Evicted while logging in (credentials changed or account removed).
      // Nothing would ever release or idle-close this login, and it carries
      // the old password, so close it rather than hand it out.
      if (this.pool.get(account.id) !== entry) {
        client.logout().catch(() => {});
        throw this.connectionResetError();
      }
      entry.client = client;
      entry.refCount++;
      const pin = this.pins.get(account.id);
      if (pin) pin.client = client;
      return client;
    } finally {
      entry.connecting = null;
    }
  }

  private connectionResetError(): ServiceUnavailableException {
    return new ServiceUnavailableException({ title: 'Mail connection reset', status: 503 });
  }

  /**
   * Run `fn` with this account's pooled IMAP client and always release it.
   * The single entry point other services (send, drafts) use, so every IMAP
   * operation shares one login instead of opening its own.
   */
  async withClient<T>(
    accountOrId: MailAccount | string,
    fn: (client: ImapFlow, account: MailAccount) => Promise<T>,
  ): Promise<T> {
    const account =
      typeof accountOrId === 'string'
        ? await this.prisma.client.mailAccount.findUnique({ where: { id: accountOrId } })
        : accountOrId;
    if (!account || account.deletedAt) {
      throw new ServiceUnavailableException({
        title: 'Mail account unavailable',
        status: 503,
      });
    }
    const client = await this.acquireClient(account);
    try {
      return await fn(client, account);
    } finally {
      this.releaseClient(account.id);
    }
  }

  /**
   * Release a pooled client. When the last lease drops, a pinned connection
   * goes back to watching INBOX; any other schedules the idle-close timer.
   * An immediate re-acquire cancels the timer so back-to-back syncs share the
   * same socket.
   */
  private releaseClient(accountId: string): void {
    const entry = this.pool.get(accountId);
    if (!entry) return;
    if (entry.refCount > 0) entry.refCount--;
    if (entry.refCount === 0) {
      if (this.pins.has(accountId)) {
        void this.returnToInbox(accountId);
      } else {
        this.scheduleIdleClose(accountId, entry);
      }
    }
  }

  private scheduleIdleClose(accountId: string, entry: PooledConnection): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const e = this.pool.get(accountId);
      if (!e || e.refCount > 0 || this.pins.has(accountId)) return;
      this.pool.delete(accountId);
      e.client?.logout().catch(() => {
        /* server may have already closed it - fine */
      });
    }, ImapSyncService.POOL_IDLE_TIMEOUT_MS);
  }

  /**
   * Hold this account's pooled connection open for the IDLE watcher (logging
   * in through the governor if there is none) and park it on INBOX. Throws
   * the governor's backoff error without touching the network while the
   * account or its host is backing off. Replaces any earlier pin.
   */
  async pinClient(account: MailAccount, handlers: PinHandlers): Promise<void> {
    // Stopped before we got here: do not log in for it at all.
    if (handlers.cancelled) throw this.connectionResetError();
    const client = await this.acquireClient(account);
    // The watcher was stopped while we logged in. Pinning now could replace
    // the pin of the watcher that took over from it.
    if (handlers.cancelled) {
      this.releaseClient(account.id);
      return;
    }
    // Keep the INBOX baseline when re-pinning the same connection, or seed it
    // from INBOX if that is what the connection has selected.
    const prev = this.pins.get(account.id);
    const onInbox = client.mailbox && client.mailbox.path === handlers.inboxPath;
    const baseline =
      prev && prev.client === client
        ? { inboxExists: prev.inboxExists, inboxUidNext: prev.inboxUidNext }
        : {
            inboxExists: onInbox && client.mailbox ? client.mailbox.exists : null,
            inboxUidNext: onInbox && client.mailbox ? client.mailbox.uidNext : null,
          };
    this.pins.set(account.id, { handlers, client, ...baseline });
    // Pinned before release, so the release parks it on INBOX instead of
    // scheduling the idle close.
    this.releaseClient(account.id);
  }

  /**
   * How long before a login for this account could go through: its own
   * backoff, or its mail server's open circuit. Lets the IDLE watcher sleep
   * until then instead of retrying into a closed gate.
   */
  msUntilConnectAllowed(accountId: string): number {
    return this.governor.msUntilAllowed(this.hostKeys.get(accountId) ?? '', accountId);
  }

  /**
   * Drop the watcher's hold. Only removes the pin these handlers created, so a
   * watcher stopped late never unpins its replacement. The connection then
   * idle-closes like any other.
   */
  unpinClient(accountId: string, handlers: PinHandlers): void {
    const pin = this.pins.get(accountId);
    if (!pin || pin.handlers !== handlers) return;
    this.pins.delete(accountId);
    const entry = this.pool.get(accountId);
    if (entry && entry.refCount === 0) this.scheduleIdleClose(accountId, entry);
  }

  /** False when the pinned connection is gone or imapflow reports it unusable. */
  isPinnedUsable(accountId: string): boolean {
    const client = this.pins.get(accountId)?.client;
    return !!client && client.usable !== false;
  }

  /**
   * Put a pinned connection back on INBOX and IDLE it. imapflow only IDLEs
   * the selected mailbox, so after a sync of Sent (or a mark-read in Archive)
   * the watcher would otherwise be watching the wrong folder. Mail that
   * reached INBOX while we were elsewhere raises no EXISTS, so compare the
   * count and UIDNEXT with what we last saw and sync if either moved.
   */
  private async returnToInbox(accountId: string): Promise<void> {
    const pin = this.pins.get(accountId);
    const client = pin?.client;
    if (!pin || !client || !client.usable) return;
    try {
      const selected = client.mailbox ? client.mailbox.path : null;
      if (selected !== pin.handlers.inboxPath) {
        const lock = await client.getMailboxLock(pin.handlers.inboxPath);
        const count = client.mailbox ? client.mailbox.exists : null;
        const uidNext = client.mailbox ? client.mailbox.uidNext : null;
        lock.release();
        const countMoved = count != null && pin.inboxExists != null && count !== pin.inboxExists;
        const uidMoved = uidNext != null && pin.inboxUidNext != null && uidNext > pin.inboxUidNext;
        if (countMoved || uidMoved) pin.handlers.onExists();
        if (count != null) pin.inboxExists = count;
        if (uidNext != null) pin.inboxUidNext = uidNext;
      }
      // Someone may have leased the connection while we reselected; their
      // command would break IDLE straight away, and imapflow re-IDLEs on its
      // own 15 s after they finish.
      const entry = this.pool.get(accountId);
      if (entry?.client === client && entry.refCount === 0 && !client.idling) {
        client.idle().catch(() => {
          /* a dead socket surfaces through 'close' */
        });
      }
    } catch (err) {
      this.logger.warn(
        `Pinned IMAP return to INBOX failed accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * Force the pool to drop a specific account's connection. Used by
   * mail-accounts when credentials are rotated or the account is deleted -
   * the cached client carries the OLD password and would keep failing if
   * we let it linger.
   */
  evictPooledClient(accountId: string): void {
    // New credentials deserve an immediate try, not the old password's backoff.
    this.governor.resetAccount(accountId);
    const entry = this.pool.get(accountId);
    if (!entry) return;
    // A login still in flight carries the old password; its failure would
    // re-apply the old backoff after the reset above.
    if (entry.connecting) {
      void entry.connecting
        .catch(() => undefined)
        .then(() => this.governor.resetAccount(accountId));
    }
    this.pool.delete(accountId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.client?.logout().catch(() => {});
  }

  /** Open a fresh imapflow session. Caller is responsible for `logout()`. */
  private async connect(account: MailAccount): Promise<ImapFlow> {
    // Re-resolve the host right before connecting and refuse private targets.
    // Verify-time checks alone are bypassable via DNS rebinding once the
    // account is ACTIVE; this is the connect-time backstop.
    // Connect to the vetted address, not the name (DNS rebinding).
    const target = await resolvePublicHost(account.imapHost);
    const password = this.crypto.decrypt(account.passwordCiphertext);
    const client = new ImapFlow({
      host: target.host,
      ...(target.servername ? { servername: target.servername } : {}),
      port: account.imapPort,
      secure: account.imapSecure,
      auth: { user: account.username, pass: password },
      logger: false,
      // Bumped from 30s. cPanel/Dovecot under load occasionally pauses a
      // response for 30–60s; the previous limit fired during legitimate
      // operations and crashed the process via unhandled 'error' events.
      // During IDLE a timeout does not close the socket: imapflow sends a
      // NOOP and resumes IDLE, which also keeps NAT mappings warm.
      socketTimeout: 120_000,
      // imapflow's 90 s default holds one of the governor's login slots for
      // a minute and a half when the host drops our packets. A healthy TLS
      // handshake to the mail host takes well under a second.
      connectionTimeout: 30_000,
      // Break and restart IDLE every 5 minutes so a dead socket surfaces
      // within one cycle on the connection the IDLE watcher pins.
      maxIdleTime: 5 * 60_000,
    });
    // ImapFlow uses Node's EventEmitter for transport failures. If we don't
    // attach an 'error' listener, Node treats the event as fatal and kills
    // the whole API process - which is exactly the crash we saw after a
    // self-addressed send. Treat IMAP transport failures as warnings: the
    // operation that triggered the connection will reject with the same
    // error, the caller logs and recovers, and the process stays up.
    client.on('error', (err: Error) => {
      this.logger.warn(
        `ImapFlow transport error accountId=${account.id} host=${account.imapHost} message=${err?.message ?? 'unknown'}`,
      );
    });
    client.on('close', () => {
      const entry = this.pool.get(account.id);
      if (entry?.client === client) entry.client = null as unknown as ImapFlow;
      const pin = this.pins.get(account.id);
      if (!pin || pin.client !== client || this.destroyed) return;
      pin.client = null;
      pin.handlers.onClose();
    });
    // INBOX changes reach the watcher whichever lease has the connection.
    // Changes in other folders belong to whoever has that folder open.
    client.on('exists', (event) => {
      const pin = this.pins.get(account.id);
      if (!pin || event.path !== pin.handlers.inboxPath) return;
      pin.inboxExists = event.count;
      pin.handlers.onExists();
    });
    client.on('expunge', (event) => {
      const pin = this.pins.get(account.id);
      if (!pin || event.path !== pin.handlers.inboxPath) return;
      // imapflow has already decremented the count.
      pin.inboxExists =
        client.mailbox && client.mailbox.path === pin.handlers.inboxPath
          ? client.mailbox.exists
          : null;
      pin.handlers.onExpunge();
    });
    // Leaving INBOX for another folder: remember its count so returnToInbox
    // can tell whether mail arrived while we were away.
    client.on('mailboxClose', (mailbox) => {
      const pin = this.pins.get(account.id);
      if (!pin || pin.client !== client || mailbox.path !== pin.handlers.inboxPath) return;
      pin.inboxExists = mailbox.exists;
      // Possibly stale-low (EXISTS does not bump it); that costs at most one
      // extra sync on return.
      pin.inboxUidNext = mailbox.uidNext;
    });
    // Keyed by the server address, not the name: on shared hosting many
    // mail.<domain> names point at one server, and its firewall counts
    // connections per address.
    this.hostKeys.set(account.id, target.host);
    await this.governor.connect(target.host, account.id, () =>
      client.connect().catch((err: unknown) => {
        // imapflow leaves the socket open after a rejected LOGIN until the
        // socket timeout; that is one more connection the host's firewall
        // counts against us.
        client.close();
        throw err;
      }),
    );
    return client;
  }

  /** Pull the folder list and upsert MailFolder rows. */
  async syncFolders(accountId: string): Promise<FolderSyncResult> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) {
      return { totalFolders: 0, inboxId: null };
    }

    const client = await this.acquireClient(account);
    try {
      const folders = await client.list();

      // Pre-compute role assignments. Some servers (notably cPanel) expose
      // multiple folders that match the same role - e.g. both INBOX.Junk
      // and INBOX.spam map to SPAM. Without disambiguation, the sidebar
      // shows duplicate "Spam" entries. Pick the single best candidate
      // for each role: SPECIAL-USE-flagged > shorter path > alphabetical.
      const candidates = folders.map((f) => ({
        folder: f,
        role: roleFromFolder(f),
        hasSpecialUse: !!f.specialUse,
      }));
      const winners = new Map<string, string>(); // role -> winning folder.path
      const ROLES = ['INBOX', 'SENT', 'DRAFTS', 'TRASH', 'SPAM', 'ARCHIVE', 'ALL', 'FLAGGED'] as const;
      for (const role of ROLES) {
        const matches = candidates.filter((c) => c.role === role);
        if (matches.length === 0) continue;
        matches.sort((a, b) => {
          if (a.hasSpecialUse !== b.hasSpecialUse) return a.hasSpecialUse ? -1 : 1;
          const lenDiff = a.folder.path.length - b.folder.path.length;
          if (lenDiff !== 0) return lenDiff;
          return a.folder.path.localeCompare(b.folder.path);
        });
        winners.set(role, matches[0]!.folder.path);
      }

      let inboxId: string | null = null;
      for (const folder of folders) {
        const detected = roleFromFolder(folder);
        // Only the winner for each role keeps the role assignment; runners-up
        // are demoted to null so they show up under their literal name.
        const role =
          detected != null && winners.get(detected) === folder.path
            ? detected
            : null;
        const delimiter = folder.delimiter || '/';

        const row = await this.prisma.client.mailFolder.upsert({
          where: { accountId_path: { accountId, path: folder.path } },
          create: {
            accountId,
            path: folder.path,
            name: folder.name || folder.path,
            role,
            delimiter,
            position: positionFor(role),
          },
          update: {
            name: folder.name || folder.path,
            role,
            delimiter,
            position: positionFor(role),
          },
        });
        if (row.role === 'INBOX') inboxId = row.id;
      }

      return { totalFolders: folders.length, inboxId };
    } finally {
      this.releaseClient(accountId);
    }
  }

  /**
   * Import new messages for one folder. Safe to call from anywhere and as
   * often as you like: concurrent calls for the same folder coalesce (see
   * `folderSyncs`), and the work itself is batched and resumable.
   */
  syncFolderMessages(
    accountId: string,
    folderId: string,
    limit: number = INITIAL_FETCH_LIMIT,
  ): Promise<MessageSyncResult> {
    const existing = this.folderSyncs.get(folderId);
    if (existing) {
      if (!existing.followUp) {
        existing.followUp = existing.running
          .catch(() => undefined)
          .then(() => this.syncFolderMessages(accountId, folderId, limit));
      }
      return existing.followUp;
    }
    const entry: {
      running: Promise<MessageSyncResult>;
      followUp: Promise<MessageSyncResult> | null;
    } = { running: Promise.resolve({ inserted: 0, updated: 0 }), followUp: null };
    entry.running = this.runFolderSync(accountId, folderId, limit)
      .then(async (result) => {
        // Every successful run counts as "synced", including no-op runs.
        // Only stamping when something was imported left idle mailboxes
        // looking permanently stale, so the page poll re-ran a sync on every
        // tick.
        await this.prisma.client.mailAccount
          .update({ where: { id: accountId }, data: { lastSyncedAt: new Date() } })
          .catch(() => undefined);
        return result;
      })
      .finally(() => {
        if (this.folderSyncs.get(folderId) === entry) this.folderSyncs.delete(folderId);
      });
    this.folderSyncs.set(folderId, entry);
    return entry.running;
  }

  /**
   * Forward-only, batched import.
   *
   * The previous version fetched `cursor:*` with full message source in ONE
   * command and buffered every message in memory before saving any of them.
   * On a busy mailbox with a backlog (after a deploy, an IDLE drop, a burst)
   * that single response ran past the socket timeout, nothing was saved, the
   * cursor never moved, and every retry re-downloaded an even bigger range.
   * The CRM went silent while webmail had the mail.
   *
   * Now: list the new UIDs, then fetch and save them SYNC_BATCH at a time,
   * advancing the persisted cursor after every saved message. The mailbox
   * lock is held only while talking to the server, never while writing to the
   * database, so user actions (mark read, move) interleave between batches.
   * Oversized messages skip the full source download; only their text parts
   * are fetched. A run imports at most `limit` messages and schedules a
   * follow-up for the rest.
   */
  private async runFolderSync(
    accountId: string,
    folderId: string,
    limit: number,
  ): Promise<MessageSyncResult> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) return { inserted: 0, updated: 0 };

    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
    });
    if (!folder) return { inserted: 0, updated: 0 };

    const client = await this.acquireClient(account);
    let inserted = 0;
    let updated = 0;
    let remaining = 0;
    let reconciled = 0;
    const newInboxMessages: Array<{
      id: string;
      subject: string;
      fromName: string | null;
      fromAddress: string;
    }> = [];
    try {
      // ---- Phase 1: reconcile the cursor and list new UIDs (under lock).
      let newUids: number[] = [];
      let serverUidNext: bigint | null = null;
      {
        const lock = await client.getMailboxLock(folder.path);
        try {
          const mbox =
            client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox : null;
          const rawExists = (mbox as { exists?: number | string } | null)?.exists;
          const totalExists = Number.isFinite(Number(rawExists)) ? Math.trunc(Number(rawExists)) : 0;
          serverUidNext = mbox?.uidNext != null ? BigInt(mbox.uidNext) : null;
          const serverValidity = mbox?.uidValidity != null ? BigInt(mbox.uidValidity) : null;

          // We deliberately do NOT write `unreadCount` here. IMAP STATUS
          // UNSEEN counts historical mail that forward-only sync never
          // imported; listFolders() derives the badge from rows we have.
          if (serverValidity != null) {
            await this.prisma.client.mailFolder.update({
              where: { id: folderId },
              data: {
                uidValidity: serverValidity,
                totalCount: Number.isFinite(Number(rawExists)) ? totalExists : folder.totalCount,
              },
            });
          }

          let cursor = folder.uidNext;

          // UIDVALIDITY rotation (mailbox rebuilt or migrated on the server):
          // every UID we hold now points at a different message. Drop the
          // local mirror for this folder (the server still has the mail) and
          // re-anchor near the new UIDNEXT so the latest messages reappear.
          // The old code kept the stale cursor, which could hide all new mail
          // until the new UID space caught up with it.
          if (
            serverValidity != null &&
            folder.uidValidity != null &&
            serverValidity !== folder.uidValidity
          ) {
            const anchor = this.recoveryAnchor(serverUidNext, limit);
            this.logger.warn(
              `UIDVALIDITY changed folder=${folder.path} stored=${folder.uidValidity} server=${serverValidity}. Clearing local mirror, cursor -> ${anchor}.`,
            );
            await this.prisma.client.mailMessage.deleteMany({ where: { folderId } });
            await this.prisma.client.mailFolder.update({
              where: { id: folderId },
              data: { uidNext: anchor, unreadCount: 0 },
            });
            cursor = anchor;
          }

          if (totalExists === 0) {
            if (serverUidNext != null && serverUidNext > (cursor ?? 0n)) {
              await this.prisma.client.mailFolder.update({
                where: { id: folderId },
                data: { uidNext: serverUidNext },
              });
            }
            // The folder is empty on the server but we may still be
            // mirroring rows for it - someone emptied it in webmail, or the
            // mail was moved out from another client. Those rows kept
            // counting toward the unread badge indefinitely. Only prune when
            // the server actually reported EXISTS: a missing value parses to
            // 0 above, and that must not be read as "delete everything".
            if (Number.isFinite(Number(rawExists))) {
              const { count } = await this.prisma.client.mailMessage.deleteMany({
                where: { folderId },
              });
              if (count > 0) {
                this.logger.log(
                  `Cleared ${count} row(s) for now-empty folder=${folder.path}`,
                );
              }
              await this.prisma.client.mailFolder.update({
                where: { id: folderId },
                data: { unreadCount: 0 },
              });
            }
            return { inserted: 0, updated: 0 };
          }

          // Self-heal: nothing local but the server has mail, so the cursor is
          // stranded ahead of un-fetched messages. Walk it back so the most
          // recent messages are recovered.
          if (cursor != null) {
            const localCount = await this.prisma.client.mailMessage.count({
              where: { folderId },
            });
            if (localCount === 0 && serverUidNext != null) {
              const anchor = this.recoveryAnchor(serverUidNext, limit);
              if (anchor < cursor) {
                this.logger.warn(
                  `Self-heal folder=${folder.path}: local empty, server has ${totalExists}. Cursor ${cursor} -> ${anchor}.`,
                );
                cursor = anchor;
                await this.prisma.client.mailFolder.update({
                  where: { id: folderId },
                  data: { uidNext: anchor },
                });
              }
            }
          }

          // First sync: anchor near the top so the latest few messages show up,
          // without importing the historical mailbox.
          if (cursor == null) {
            const anchor = this.recoveryAnchor(serverUidNext, limit);
            this.logger.log(
              `Sync watermark set folder=${folder.path} serverUidNext=${serverUidNext ?? 'null'} cursor=${anchor}`,
            );
            cursor = anchor;
            await this.prisma.client.mailFolder.update({
              where: { id: folderId },
              data: { uidNext: anchor },
            });
          }
          folder.uidNext = cursor;

          // Always ask the server for UIDs past the cursor. The cached
          // UIDNEXT cannot gate this: imapflow refreshes it only on SELECT or
          // STATUS, and an EXISTS during IDLE bumps just the message count.
          // On a connection already sitting on this folder (the IDLE-pinned
          // INBOX, or a pooled one that last synced it) the stale UIDNEXT
          // equals the cursor and new mail was never listed. An empty result
          // is still not an early return: Phase 3 below has to reconcile
          // flags for the mail we already hold.
          {
            // UIDs start at 1; a manual resync rewinds the cursor to 0.
            const floor = cursor < 1n ? 1n : cursor;
            const found = await client.search({ uid: `${floor}:*` }, { uid: true });
            // imapflow returns false when SEARCH fails (the socket dropped
            // mid-command). Read as "nothing new", the backstop below would
            // move the cursor past mail we never listed.
            if (!Array.isArray(found)) {
              throw new ServiceUnavailableException({ title: 'Mail search failed', status: 503 });
            }
            newUids = found
              .filter((u) => BigInt(u) >= floor)
              .sort((a, b) => a - b);
            if (newUids.length > 0) {
              const top = BigInt(newUids[newUids.length - 1]!) + 1n;
              if (serverUidNext == null || top > serverUidNext) serverUidNext = top;
            }
          }
        } finally {
          lock.release();
        }
      }

      const runUids = newUids.slice(0, Math.max(limit, SYNC_BATCH));
      remaining = newUids.length - runUids.length;

      // ---- Phase 2: fetch and save in bounded batches.
      for (let i = 0; i < runUids.length; i += SYNC_BATCH) {
        const batch = runUids.slice(i, i + SYNC_BATCH);
        const batchSet = batch.join(',');

        const known = await this.prisma.client.mailMessage.findMany({
          where: { accountId, folderId, uid: { in: batch.map((u) => BigInt(u)) } },
          select: { uid: true },
        });
        const knownUids = new Set(known.map((k) => Number(k.uid)));

        const metas: FetchMessageObject[] = [];
        const sources = new Map<number, Buffer>();
        const textBodies = new Map<number, TextBodies>();
        {
          const lock = await client.getMailboxLock(folder.path);
          try {
            for await (const msg of client.fetch(
              batchSet,
              {
                uid: true,
                envelope: true,
                flags: true,
                bodyStructure: true,
                size: true,
                internalDate: true,
              },
              { uid: true },
            )) {
              metas.push(msg);
            }

            // Full source only for messages we have not stored yet and that
            // are small enough to pull whole. Flag-only updates need none.
            const wantSource = metas
              .filter((m) => m.uid != null && !knownUids.has(m.uid) && (m.size ?? 0) <= MAX_SOURCE_BYTES)
              .map((m) => m.uid as number);
            if (wantSource.length > 0) {
              for await (const msg of client.fetch(
                wantSource.join(','),
                { uid: true, source: true },
                { uid: true },
              )) {
                if (msg.uid != null && msg.source) sources.set(msg.uid, msg.source);
              }
            }

            for (const m of metas) {
              if (m.uid == null || knownUids.has(m.uid) || (m.size ?? 0) <= MAX_SOURCE_BYTES) continue;
              textBodies.set(
                m.uid,
                await this.downloadTextParts(client, m.uid, m.bodyStructure as BodyStructureNode | undefined),
              );
            }
          } finally {
            lock.release();
          }
        }

        metas.sort((a, b) => (a.uid ?? 0) - (b.uid ?? 0));
        for (const meta of metas) {
          if (meta.uid == null || BigInt(meta.uid) < (folder.uidNext ?? 0n)) continue;
          const source = sources.get(meta.uid);
          const msg = (source ? { ...meta, source } : meta) as FetchMessageObject;
          // One bad message must never take down the whole sync.
          try {
            const result = await this.upsertMessage(
              accountId,
              folderId,
              msg,
              client,
              folder.path,
              textBodies.get(meta.uid),
            );
            if (result.status === 'inserted') {
              inserted++;
              if (folder.role === 'INBOX' && result.created) newInboxMessages.push(result.created);
            } else if (result.status === 'updated') {
              updated++;
            }
          } catch (err) {
            this.logger.warn(
              `upsertMessage failed accountId=${accountId} uid=${meta.uid} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          }
          // Advance the persisted cursor past this UID straight away, so a
          // failure later in the batch never re-downloads what was saved.
          const nextCursor = BigInt(meta.uid) + 1n;
          if (nextCursor > (folder.uidNext ?? 0n)) {
            folder.uidNext = nextCursor;
            await this.prisma.client.mailFolder.update({
              where: { id: folderId },
              data: { uidNext: nextCursor },
            });
          }
        }
      }

      // Backstop: nothing listed but the server's UIDNEXT moved (a message was
      // expunged before we got to it). Catch the cursor up so we don't loop on
      // a gap the server already skipped.
      if (
        runUids.length === 0 &&
        serverUidNext != null &&
        serverUidNext > (folder.uidNext ?? 0n)
      ) {
        await this.prisma.client.mailFolder.update({
          where: { id: folderId },
          data: { uidNext: serverUidNext },
        });
      }

      // ---- Phase 3: reconcile flags for mail we already hold.
      // Phases 1-2 are forward-only, so without this a message read in
      // webmail, on a phone, or in Outlook stays bold here forever and the
      // unread badge only ever grows.
      reconciled = await this.reconcileFolderFlags(client, folder);
    } finally {
      this.releaseClient(accountId);
    }

    // Notify the mailbox owner about new INBOX arrivals. One banner per
    // message up to a small cap; beyond that, a single rollup so a burst of
    // mail doesn't carpet-bomb the bell. entityId = MailMessage.id so opening
    // the message clears its notification (contextual auto-read).
    if (newInboxMessages.length > 0) {
      const NOTIFY_CAP = 5;
      const shown = newInboxMessages.slice(0, NOTIFY_CAP);
      for (const m of shown) {
        const sender = m.fromName?.trim() || m.fromAddress;
        void this.notifications
          .emit({
            userId: account.userId,
            type: 'MAIL_RECEIVED',
            title: `New mail from ${sender}`,
            body: m.subject || '(no subject)',
            entityType: 'mail',
            entityId: m.id,
            url: '/mail',
            pushType: 'message',
          })
          .catch(() => {});
      }
      if (newInboxMessages.length > NOTIFY_CAP) {
        void this.notifications
          .emit({
            userId: account.userId,
            type: 'MAIL_RECEIVED',
            title: `${newInboxMessages.length} new emails`,
            body: 'You have several new messages in your inbox.',
            entityType: 'mail',
            entityId: accountId,
            url: '/mail',
            pushType: 'message',
          })
          .catch(() => {});
      }
    }

    if (inserted > 0 || updated > 0 || reconciled > 0) {
      this.logger.log(
        `Sync ok folder=${folder.path} inserted=${inserted} updated=${updated} reconciled=${reconciled} remaining=${remaining}`,
      );
    }

    // Drain the rest of a large backlog in the background.
    if (remaining > 0) {
      setTimeout(() => {
        void this.syncFolderMessages(accountId, folderId, limit).catch((err) => {
          this.logger.warn(
            `Backlog continuation failed folder=${folder.path} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        });
      }, 0);
    }

    return { inserted, updated: updated + reconciled };
  }

  /**
   * Re-read IMAP flags for the most recent `FLAG_RECONCILE_WINDOW` messages
   * we already hold in a folder, and drop rows the server no longer has.
   *
   * This is the missing half of the sync. Message import is forward-only
   * past the stored UID cursor, so once a row exists its \\Seen / \\Flagged
   * state was frozen at import time. Read the mail in webmail or on your
   * phone and the CRM kept showing it bold; delete it there and the row (and
   * its contribution to the unread badge) stayed forever. Both of those show
   * up to the user as "the unread count is wrong".
   *
   * Cheap by construction: one FETCH over a bounded UID range asking for
   * flags only - no envelopes, no bodies - throttled to one pass per folder
   * per `FLAG_RECONCILE_INTERVAL_MS`.
   *
   * Conflict rules (see mail-flag-reconcile.ts): a local row touched within
   * `LOCAL_FLAG_GRACE_MS` keeps its own state, so a mark-as-read from a
   * second ago is never undone by a FETCH response that predates our STORE.
   * A read or star change the server never confirmed (`seenPendingAt`,
   * `starredPendingAt`) is re-sent to the server instead of overwritten, so
   * a failed STORE is retried here rather than silently reverting the
   * user's click.
   *
   * Returns the number of rows changed. Never throws - reconciliation is an
   * optimization, and a failure here must not fail the import that preceded it.
   */
  private readonly lastReconcileAt = new Map<string, number>();
  private async reconcileFolderFlags(
    client: ImapFlow,
    folder: MailFolder,
  ): Promise<number> {
    const now = Date.now();
    if (
      now - (this.lastReconcileAt.get(folder.id) ?? 0) <
      FLAG_RECONCILE_INTERVAL_MS
    ) {
      return 0;
    }
    this.lastReconcileAt.set(folder.id, now);

    try {
      const local = await this.prisma.client.mailMessage.findMany({
        where: { folderId: folder.id },
        orderBy: { uid: 'desc' },
        take: FLAG_RECONCILE_WINDOW,
        select: {
          id: true,
          uid: true,
          isUnread: true,
          isStarred: true,
          isAnswered: true,
          updatedAt: true,
          seenPendingAt: true,
          starredPendingAt: true,
        },
      });
      if (local.length === 0) return 0;

      const maxUid = local[0]!.uid;
      const minUid = local[local.length - 1]!.uid;
      const range = `${minUid}:${maxUid}`;

      const serverFlags = new Map<string, string[]>();
      const lock = await client.getMailboxLock(folder.path);
      try {
        for await (const msg of client.fetch(
          range,
          { uid: true, flags: true },
          { uid: true },
        )) {
          if (msg.uid == null) continue;
          serverFlags.set(String(msg.uid), Array.from(msg.flags ?? []));
        }
      } finally {
        lock.release();
      }

      // An empty response for a range we know holds mail means the FETCH
      // failed or the mailbox was swapped under us. Bail rather than treat
      // every message as expunged.
      if (serverFlags.size === 0) return 0;

      let changed = 0;
      let revertedToUnread = 0;
      const vanished: string[] = [];
      // Pending changes to send again: the row as read, and what to set.
      type Repush = { row: (typeof local)[number]; seen: boolean | null; flagged: boolean | null };
      const repush: Repush[] = [];
      for (const row of local) {
        const flags = serverFlags.get(String(row.uid));
        if (!flags) {
          vanished.push(row.id);
          continue;
        }
        const decision = decideFlags(row, serverFlagsOf(flags), now, LOCAL_FLAG_GRACE_MS);
        if (decision.kind === 'keep') continue;
        if (decision.repushSeen !== null || decision.repushFlagged !== null) {
          repush.push({ row, seen: decision.repushSeen, flagged: decision.repushFlagged });
        }
        const pendingAfter = decision.repushSeen !== null || decision.repushFlagged !== null;
        const data: Prisma.MailMessageUpdateManyMutationInput = {
          ...decision.adopt,
          ...(decision.clearSeen ? { seenPendingAt: null } : {}),
          ...(decision.clearStarred ? { starredPendingAt: null } : {}),
          // The flags JSON mirrors the server only once nothing is pending.
          ...(pendingAfter ? {} : { flags: flags as unknown as Prisma.InputJsonValue }),
        };
        if (Object.keys(data).length === 0) continue;
        // Only if the row is unchanged since it was read: a click during
        // this pass (and its pending marker) must not be overwritten.
        const { count } = await this.prisma.client.mailMessage.updateMany({
          where: { id: row.id, updatedAt: row.updatedAt },
          data,
        });
        if (count === 0) continue;
        changed++;
        if (decision.adopt.isUnread === true && !row.isUnread) revertedToUnread++;
      }
      // A message read here, now unread on the server with nothing pending:
      // it was marked unread in another app. Logged so a revert from any
      // other cause shows up.
      if (revertedToUnread > 0) {
        this.logger.log(
          `Reconcile marked ${revertedToUnread} message(s) unread from the server folder=${folder.path}`,
        );
      }

      // Rows inside the queried UID range that the server did not return
      // have been expunged elsewhere (deleted or moved in webmail). Drop the
      // local mirror - the mail itself lives on the server, and leaving the
      // row behind is exactly what inflates the unread badge.
      if (vanished.length > 0) {
        const { count } = await this.prisma.client.mailMessage.deleteMany({
          where: { id: { in: vanished } },
        });
        changed += count;
        this.logger.log(
          `Pruned ${count} expunged message(s) folder=${folder.path}`,
        );
      }

      // Keep the stored counter honest too. listFolders() derives the badge
      // from rows rather than this column, but a stale value here is a trap
      // for anything that reads it later.
      const unread = await this.prisma.client.mailMessage.count({
        where: { folderId: folder.id, isUnread: true },
      });
      if (unread !== folder.unreadCount) {
        await this.prisma.client.mailFolder.update({
          where: { id: folder.id },
          data: { unreadCount: unread },
        });
      }

      // Last, so a failure here can never skip the prune or the recount.
      if (repush.length > 0) {
        await this.repushPending(client, folder, repush).catch((err: unknown) =>
          this.logger.warn(
            `Pending flag re-push skipped folder=${folder.path} message=${(err as Error)?.message ?? 'unknown'}`,
          ),
        );
      }

      return changed;
    } catch (err) {
      this.logger.warn(
        `Flag reconcile failed folder=${folder.path} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      return 0;
    }
  }

  /**
   * Send pending read/star changes to the server again (from the reconcile
   * pass). Rows are re-read under the mailbox lock and kept only if their
   * marker and value are exactly as the pass saw them: a click in between
   * owns the flag now, and its own STORE queues behind this lock, so ours
   * can never land after it. A marker is cleared by its exact stamp, only
   * when the STORE really applied.
   */
  private async repushPending(
    client: ImapFlow,
    folder: MailFolder,
    candidates: { row: { id: string; uid: bigint; isUnread: boolean; isStarred: boolean; seenPendingAt: Date | null; starredPendingAt: Date | null }; seen: boolean | null; flagged: boolean | null }[],
  ): Promise<void> {
    const sent = { seen: 0, flagged: 0 };
    const lock = await client.getMailboxLock(folder.path);
    try {
      const current = new Map(
        (
          await this.prisma.client.mailMessage.findMany({
            where: { id: { in: candidates.map((c) => c.row.id) } },
            select: { id: true, isUnread: true, isStarred: true, seenPendingAt: true, starredPendingAt: true },
          })
        ).map((r) => [r.id, r] as const),
      );
      const sameStamp = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

      for (const field of ['seen', 'flagged'] as const) {
        const column = field === 'seen' ? 'seenPendingAt' : 'starredPendingAt';
        // One STORE per value to set; each row keeps its own stamp to clear.
        const groups = new Map<boolean, { id: string; uid: bigint; stamp: Date }[]>();
        for (const c of candidates) {
          const value = c[field];
          if (value === null) continue;
          const now = current.get(c.row.id);
          if (!now) continue;
          const stamp = field === 'seen' ? c.row.seenPendingAt : c.row.starredPendingAt;
          const unchanged =
            field === 'seen'
              ? sameStamp(now.seenPendingAt, stamp) && now.isUnread === c.row.isUnread
              : sameStamp(now.starredPendingAt, stamp) && now.isStarred === c.row.isStarred;
          if (!unchanged || !stamp) continue;
          const rows = groups.get(value) ?? [];
          rows.push({ id: c.row.id, uid: c.row.uid, stamp });
          groups.set(value, rows);
        }
        for (const [value, rows] of groups) {
          try {
            await this.storeFlag(
              client,
              rows.map((r) => r.uid.toString()).join(','),
              field === 'seen' ? '\\Seen' : '\\Flagged',
              value,
            );
          } catch (err) {
            // A lasting failure (read-only mailbox, host refusing): one
            // warning and stop, instead of hammering it under the lock.
            this.logger.warn(
              `Pending ${field} re-push failed folder=${folder.path} count=${rows.length} message=${(err as Error)?.message ?? 'unknown'}`,
            );
            break;
          }
          const byStamp = new Map<number, string[]>();
          for (const r of rows) {
            byStamp.set(r.stamp.getTime(), [...(byStamp.get(r.stamp.getTime()) ?? []), r.id]);
          }
          for (const [stamp, ids] of byStamp) await this.clearPending(ids, column, new Date(stamp));
          sent[field] += rows.length;
        }
      }
    } finally {
      lock.release();
    }
    if (sent.seen + sent.flagged > 0) {
      this.logger.log(
        `Re-sent pending changes folder=${folder.path} read=${sent.seen} star=${sent.flagged}`,
      );
    }
  }

  /**
   * One STORE that must really apply. imapflow resolves `false` instead of
   * throwing when the mailbox is not selected, the server answers NO/BAD, or
   * the socket drops mid-command; ignoring that let a failed "mark as read"
   * look like a success, so it was never retried and later reverted.
   */
  private async storeFlag(client: ImapFlow, range: string, flag: string, value: boolean): Promise<void> {
    const applied = value
      ? await client.messageFlagsAdd(range, [flag], { uid: true })
      : await client.messageFlagsRemove(range, [flag], { uid: true });
    if (!applied) throw new Error(`STORE ${value ? '+' : '-'}${flag} was not applied`);
  }

  /** Cursor that re-imports roughly the latest `min(limit, 50)` messages. */
  private recoveryAnchor(serverUidNext: bigint | null, limit: number): bigint {
    if (serverUidNext == null) return 1n;
    const window = BigInt(Math.min(limit, 50));
    return serverUidNext > window ? serverUidNext - window : 1n;
  }

  /**
   * Fetch only the text/plain and text/html parts of an oversized message.
   * imapflow decodes the transfer encoding and converts the charset to UTF-8
   * for text parts, so the result can be stored as-is.
   */
  private async downloadTextParts(
    client: ImapFlow,
    uid: number,
    structure: BodyStructureNode | undefined,
  ): Promise<TextBodies> {
    const bodies: TextBodies = { text: null, html: null };
    if (!structure) return bodies;
    const parts: { part: string; kind: 'text' | 'html' }[] = [];
    const walk = (n: BodyStructureNode) => {
      if (n.childNodes && n.childNodes.length > 0) {
        for (const c of n.childNodes) walk(c);
        return;
      }
      const disposition = (n.disposition ?? '').toLowerCase();
      if (disposition === 'attachment' || n.dispositionParameters?.filename) return;
      const type = `${n.type ?? ''}/${n.subtype ?? ''}`.toLowerCase();
      const part = n.part ?? n.partID ?? '1';
      if (type === 'text/plain' && !parts.some((p) => p.kind === 'text')) parts.push({ part, kind: 'text' });
      if (type === 'text/html' && !parts.some((p) => p.kind === 'html')) parts.push({ part, kind: 'html' });
    };
    walk(structure);
    for (const p of parts) {
      try {
        const dl = await client.download(String(uid), p.part, { uid: true, maxBytes: 2_000_000 });
        if (!dl?.content) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const value = Buffer.concat(chunks).toString('utf8');
        if (p.kind === 'text') bodies.text = value;
        else bodies.html = value;
      } catch (err) {
        this.logger.warn(
          `Text part download failed uid=${uid} part=${p.part} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    return bodies;
  }

  /** Convenience: sync folders then INBOX messages. Called after a
   *  verify-account succeeds, and as the recurring poll tick. */
  async syncAccount(accountId: string): Promise<void> {
    const { inboxId } = await this.syncFolders(accountId);
    if (inboxId) {
      await this.syncFolderMessages(accountId, inboxId, INITIAL_FETCH_LIMIT);
    }
  }

  /**
   * Toggle the \\Seen flag on a single message - both local DB and remote
   * IMAP server. Also keeps `MailFolder.unreadCount` in sync so the sidebar
   * badge updates immediately instead of waiting for the next IMAP sync.
   *
   * Local write first, IMAP push second, deliberately. The old order (IMAP,
   * then DB) meant any hiccup on the mail host - a busy pooled connection, a
   * lock timeout, a CSF-throttled login - threw before the DB was touched,
   * the endpoint 500'd, and the client rolled its optimistic update back. To
   * the user that reads as "mark as read just doesn't work". The CRM's own
   * mirror is what the UI renders, so it is the thing that must not be lost;
   * the row stays `seenPendingAt` until the server confirms, and the
   * reconcile pass re-sends a failed STORE.
   */
  async setSeen(messageId: string, seen: boolean): Promise<void> {
    const msg = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { account: true, folder: true },
    });
    if (!msg) return;

    // Compute the unread-count delta from the *previous* DB state. If
    // the flag was already where the caller is moving it (e.g. someone
    // marked a read message as read again), the delta is 0 and we don't
    // double-decrement.
    const wasUnread = msg.isUnread;
    const willBeUnread = !seen;
    const delta = wasUnread === willBeUnread ? 0 : willBeUnread ? 1 : -1;
    // Pending until the server confirms; the reconcile pass re-sends it.
    const pendingAt = new Date();

    if (delta !== 0) {
      // Atomic: flip the message AND adjust the folder counter inside one
      // transaction so a crash between the two doesn't leave the badge
      // permanently off-by-one.
      await this.prisma.client.$transaction([
        this.prisma.client.mailMessage.update({
          where: { id: messageId },
          data: {
            isUnread: willBeUnread,
            flags: this.mergeFlags((msg.flags as string[]) ?? [], '\\Seen', seen),
            seenPendingAt: pendingAt,
          },
        }),
        this.prisma.client.mailFolder.update({
          where: { id: msg.folderId },
          data: { unreadCount: { increment: delta } },
        }),
      ]);
    } else {
      await this.prisma.client.mailMessage.update({
        where: { id: messageId },
        data: {
          isUnread: willBeUnread,
          flags: this.mergeFlags((msg.flags as string[]) ?? [], '\\Seen', seen),
          seenPendingAt: pendingAt,
        },
      });
    }

    if (await this.pushFlag(msg.account, msg.folder.path, msg.uid, '\\Seen', seen)) {
      await this.clearPending([messageId], 'seenPendingAt', pendingAt);
    }
  }

  /**
   * The server confirmed these changes. Matches on the exact pending stamp,
   * so a newer click on the same message (a later stamp) stays pending.
   */
  private async clearPending(
    ids: string[],
    column: 'seenPendingAt' | 'starredPendingAt',
    pendingAt: Date,
  ): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.client.mailMessage
      .updateMany({
        where: { id: { in: ids }, [column]: pendingAt },
        data: { [column]: null },
      })
      .catch((err: unknown) =>
        this.logger.warn(`Clearing pending flags failed message=${(err as Error)?.message ?? 'unknown'}`),
      );
  }

  /**
   * Best-effort \\Seen or \\Flagged STORE against the mail server for one or
   * more UIDs. Never throws: the local DB is already authoritative by the
   * time this runs, so a mail-host failure must not turn a successful "mark
   * as read" into an error the user sees. Returns whether the push landed.
   */
  private async pushFlag(
    account: MailAccount,
    folderPath: string,
    uids: bigint | bigint[],
    flag: '\\Seen' | '\\Flagged',
    value: boolean,
  ): Promise<boolean> {
    const list = Array.isArray(uids) ? uids : [uids];
    if (list.length === 0) return true;
    const range = list.map((u) => u.toString()).join(',');
    try {
      const client = await this.acquireClient(account);
      try {
        const lock = await client.getMailboxLock(folderPath);
        try {
          await this.storeFlag(client, range, flag, value);
        } finally {
          lock.release();
        }
      } finally {
        this.releaseClient(account.id);
      }
      return true;
    } catch (err) {
      // Logged, not thrown. The row stays pending, so the next flag
      // reconcile for this folder sends it again instead of adopting the
      // server's stale state.
      this.logger.warn(
        `${flag} push failed accountId=${account.id} folder=${folderPath} uids=${list.length} value=${value} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      return false;
    }
  }

  /**
   * Toggle the \\Flagged flag on a single message. Local first, then the
   * server, the same as setSeen: the row stays `starredPendingAt` until the
   * server confirms, and the reconcile pass re-sends a failed STORE.
   */
  async setFlagged(messageId: string, flagged: boolean): Promise<void> {
    const msg = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { account: true, folder: true },
    });
    if (!msg) return;

    const pendingAt = new Date();
    await this.prisma.client.mailMessage.update({
      where: { id: messageId },
      data: {
        isStarred: flagged,
        flags: this.mergeFlags((msg.flags as string[]) ?? [], '\\Flagged', flagged),
        starredPendingAt: pendingAt,
      },
    });
    if (await this.pushFlag(msg.account, msg.folder.path, msg.uid, '\\Flagged', flagged)) {
      await this.clearPending([messageId], 'starredPendingAt', pendingAt);
    }
  }

  /**
   * Before a MOVE (inside the source mailbox lock): send any read/star
   * change the server has not confirmed, so the moved copy carries it.
   * Best-effort; a failure never blocks the move.
   */
  private async flushPendingBeforeMove(
    client: ImapFlow,
    rows: { uid: bigint; isUnread: boolean; isStarred: boolean; seenPendingAt: Date | null; starredPendingAt: Date | null }[],
  ): Promise<void> {
    const groups: { flag: string; value: boolean; uids: string[] }[] = [];
    const add = (flag: string, value: boolean, uid: bigint) => {
      let g = groups.find((x) => x.flag === flag && x.value === value);
      if (!g) groups.push((g = { flag, value, uids: [] }));
      g.uids.push(uid.toString());
    };
    for (const r of rows) {
      if (r.seenPendingAt) add('\\Seen', !r.isUnread, r.uid);
      if (r.starredPendingAt) add('\\Flagged', r.isStarred, r.uid);
    }
    for (const g of groups) {
      await this.storeFlag(client, g.uids.join(','), g.flag, g.value).catch((err: unknown) =>
        this.logger.warn(
          `Pending ${g.flag} before move failed count=${g.uids.length} message=${(err as Error)?.message ?? 'unknown'}`,
        ),
      );
    }
  }

  /**
   * Move a single message between IMAP folders. Uses the MOVE extension when
   * the server advertises it; otherwise falls back to COPY + STORE \Deleted +
   * EXPUNGE. After the IMAP side succeeds we delete the local row - the next
   * destination-folder sync will pick the message up with its new UID, with
   * Sent/Drafts/Trash semantics preserved by IMAP flags.
   */
  async moveMessage(messageId: string, destinationFolderId: string): Promise<void> {
    const row = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { account: true, folder: true },
    });
    if (!row) return;
    const destFolder = await this.prisma.client.mailFolder.findUnique({
      where: { id: destinationFolderId },
    });
    if (!destFolder || destFolder.accountId !== row.accountId) {
      throw new Error('Destination folder belongs to a different account.');
    }
    if (destFolder.id === row.folderId) return;

    // Delete the local row FIRST so any concurrent reader (an SSE-driven
    // refetch fired by the IDLE watcher's EXPUNGE handler, or a poll tick)
    // cannot see it after the MOVE has begun. Previously we deleted after
    // the IMAP MOVE, which left a window where IDLE.triggerSync raced the
    // post-MOVE delete and resurrected the row in clients via SSE.
    //
    // If the IMAP MOVE then fails, we restore the row from the snapshot
    // we captured above. The row's uid/accountId/folderId is unchanged on
    // the server, so this re-insert puts the database back to the exact
    // pre-move state.
    await this.prisma.client.mailMessage
      .delete({ where: { id: messageId } })
      .catch(() => {});

    let moveSucceeded = false;
    const client = await this.acquireClient(row.account);
    try {
      const lock = await client.getMailboxLock(row.folder.path);
      try {
        const uid = row.uid.toString();
        // A read/star change the server never took would be lost in the
        // move: the destination sync imports the server's flags.
        await this.flushPendingBeforeMove(client, [row]);
        try {
          // imapflow's messageMove uses MOVE/COPY internally and handles the
          // server-capability negotiation. Returns destination UID when the
          // server supports UIDPLUS; we don't depend on that - we just rely
          // on the next sync to pick it up.
          await client.messageMove(uid, destFolder.path, { uid: true });
        } catch (err) {
          // Some servers (notably very old Courier) error on MOVE. Fall back
          // to copy + delete + expunge so behavior matches.
          this.logger.warn(
            `messageMove failed; falling back to copy+expunge. message=${(err as Error)?.message ?? 'unknown'}`,
          );
          await client.messageCopy(uid, destFolder.path, { uid: true });
          await client.messageFlagsAdd(uid, ['\\Deleted'], { uid: true });
          await client.messageDelete(uid, { uid: true });
        }
        moveSucceeded = true;
      } finally {
        lock.release();
      }
    } finally {
      this.releaseClient(row.account.id);
      if (!moveSucceeded) {
        // IMAP MOVE failed - put the row back exactly as it was so the user
        // doesn't lose visibility of a message that still exists on the
        // server. We re-insert with the original id so any frontend cache
        // entries keyed on it stay valid; Prisma will set new createdAt /
        // updatedAt automatically.
        await this.prisma.client.mailMessage
          .create({
            data: {
              id: row.id,
              accountId: row.accountId,
              folderId: row.folderId,
              uid: row.uid,
              messageId: row.messageId,
              subject: row.subject,
              fromAddress: row.fromAddress,
              fromName: row.fromName,
              toAddresses: row.toAddresses as Prisma.InputJsonValue,
              ccAddresses: row.ccAddresses as Prisma.InputJsonValue,
              bccAddresses: row.bccAddresses as Prisma.InputJsonValue,
              replyTo: row.replyTo,
              bodyTextPreview: row.bodyTextPreview,
              bodyText: row.bodyText,
              bodyHtml: row.bodyHtml,
              hasAttachments: row.hasAttachments,
              attachmentCount: row.attachmentCount,
              sizeBytes: row.sizeBytes,
              receivedAt: row.receivedAt,
              sentAt: row.sentAt,
              flags: row.flags as Prisma.InputJsonValue,
              isUnread: row.isUnread,
              isStarred: row.isStarred,
              isAnswered: row.isAnswered,
              seenPendingAt: row.seenPendingAt,
              starredPendingAt: row.starredPendingAt,
              inReplyTo: row.inReplyTo,
              references: (row.references as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            },
          })
          .catch((err) => {
            this.logger.warn(
              `Failed to restore message after move failure messageId=${row.id} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          });
      }
    }

    // After a successful MOVE, pull the destination folder's recent
    // messages so the moved row appears in its new home. Without this the
    // local DB has no record of the destination copy until the next time
    // someone happens to sync that folder - which currently is "never"
    // for non-INBOX folders, since syncAccount only walks INBOX. Forward-
    // only sync against the destination picks up the new copy (its UID is
    // by definition the newest in the destination mailbox) without
    // re-fetching anything else.
    //
    // Awaited (not fire-and-forget) so that by the time the API responds,
    // the destination folder has the row. The frontend's onSettled
    // invalidate then immediately surfaces it if the user has already
    // navigated to the destination. ~500ms added to the move latency but
    // makes the destination tab feel correct on click.
    if (moveSucceeded) {
      try {
        await this.syncFolderMessages(row.accountId, destFolder.id);
      } catch (err) {
        this.logger.warn(
          `Post-move destination sync failed folder=${destFolder.path} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
  }

  /**
   * Bulk-mark every unread message in a folder as read. Used by the
   * "Mark all read" affordance - significantly cheaper than client-side
   * fan-out because it opens a single IMAP connection instead of N.
   * Returns the number of messages affected.
   */
  async markFolderAllRead(folderId: string): Promise<number> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      include: { account: true },
    });
    if (!folder) return 0;
    const unread = await this.prisma.client.mailMessage.findMany({
      where: { folderId, isUnread: true },
      select: { id: true, uid: true },
    });
    if (unread.length === 0) return 0;

    // Local mirror first (see setSeen): the badge must clear even if the
    // mail host refuses the STORE, otherwise "Mark all read" appears to do
    // nothing at all.
    const pendingAt = new Date();
    await this.prisma.client.mailMessage.updateMany({
      where: { id: { in: unread.map((m) => m.id) } },
      data: { isUnread: false, seenPendingAt: pendingAt },
    });
    await this.prisma.client.mailFolder.update({
      where: { id: folderId },
      data: { unreadCount: 0 },
    });

    const pushed = await this.pushFlag(
      folder.account,
      folder.path,
      unread.map((m) => m.uid),
      '\\Seen',
      true,
    );
    if (pushed) await this.clearPending(unread.map((m) => m.id), 'seenPendingAt', pendingAt);
    return unread.length;
  }

  /**
   * Permanently delete every message in a folder via IMAP STORE \Deleted +
   * EXPUNGE. Intended for Trash/Spam - the controller restricts to those
   * folder roles. Returns the number of messages removed.
   */
  async emptyFolder(folderId: string): Promise<number> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      include: { account: true },
    });
    if (!folder) return 0;
    const messages = await this.prisma.client.mailMessage.findMany({
      where: { folderId },
      select: { id: true, uid: true },
    });
    if (messages.length === 0) return 0;

    const client = await this.acquireClient(folder.account);
    try {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const uids = messages.map((m) => m.uid.toString()).join(',');
        // Flag + delete + expunge. messageDelete on imapflow performs the
        // STORE \Deleted then UID EXPUNGE / EXPUNGE depending on capability.
        await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
        await client.messageDelete(uids, { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      this.releaseClient(folder.account.id);
    }

    await this.prisma.client.mailMessage.deleteMany({ where: { folderId } });
    await this.prisma.client.mailFolder.update({
      where: { id: folderId },
      data: { totalCount: 0, unreadCount: 0 },
    });
    return messages.length;
  }

  /**
   * Bulk-move many messages to a single destination. Messages are grouped by
   * source folder so each group opens one IMAP connection / one mailbox lock
   * and issues a single MOVE for the whole comma-separated UID list - vastly
   * cheaper than the per-message round-trip the single-message moveMessage
   * does N times.
   *
   * Destination is resolved per account: `dest.folderId` is honored when it
   * belongs to the message's account, otherwise we look up by `dest.role`.
   * Messages that can't be resolved to a destination are skipped (counted but
   * not moved) instead of failing the whole batch.
   *
   * Returns the number of messages actually moved.
   */
  async bulkMoveMessages(
    messageIds: string[],
    dest: { folderId?: string; role?: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX' },
  ): Promise<{ moved: number; skipped: number }> {
    if (messageIds.length === 0) return { moved: 0, skipped: 0 };

    const rows = await this.prisma.client.mailMessage.findMany({
      where: { id: { in: messageIds } },
      include: { account: true, folder: true },
    });

    // Group by (accountId, sourceFolderId) for one IMAP session per group.
    const groups = new Map<
      string,
      {
        account: MailAccount;
        sourceFolder: MailFolder;
        items: { id: string; uid: bigint }[];
      }
    >();
    for (const row of rows) {
      const key = `${row.accountId}::${row.folderId}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = {
          account: row.account,
          sourceFolder: row.folder,
          items: [],
        };
        groups.set(key, bucket);
      }
      bucket.items.push({ id: row.id, uid: row.uid });
    }

    let moved = 0;
    let skipped = 0;
    const touchedDestFolderIds = new Set<string>();

    for (const group of groups.values()) {
      // Resolve destination *per account*. role-based targets need a folder
      // lookup for this specific account; folderId is only honored when it
      // belongs to the same account.
      let destFolder: MailFolder | null = null;
      if (dest.folderId) {
        destFolder = await this.prisma.client.mailFolder.findUnique({
          where: { id: dest.folderId },
        });
        if (!destFolder || destFolder.accountId !== group.account.id) {
          destFolder = null;
        }
      }
      if (!destFolder && dest.role) {
        destFolder = await this.prisma.client.mailFolder.findFirst({
          where: { accountId: group.account.id, role: dest.role },
          orderBy: { position: 'asc' },
        });
      }
      if (!destFolder) {
        skipped += group.items.length;
        continue;
      }
      if (destFolder.id === group.sourceFolder.id) {
        // No-op: already in the destination folder.
        skipped += group.items.length;
        continue;
      }

      // Snapshot before delete so we can restore if IMAP MOVE fails.
      const snapshotIds = group.items.map((i) => i.id);
      const snapshot = await this.prisma.client.mailMessage.findMany({
        where: { id: { in: snapshotIds } },
      });
      await this.prisma.client.mailMessage.deleteMany({
        where: { id: { in: snapshotIds } },
      });

      let moveSucceeded = false;
      const client = await this.acquireClient(group.account);
      try {
        const lock = await client.getMailboxLock(group.sourceFolder.path);
        try {
          const uids = group.items.map((i) => i.uid.toString()).join(',');
          await this.flushPendingBeforeMove(client, snapshot);
          try {
            await client.messageMove(uids, destFolder.path, { uid: true });
          } catch (err) {
            this.logger.warn(
              `bulk messageMove failed; falling back to copy+expunge. accountId=${group.account.id} count=${group.items.length} message=${(err as Error)?.message ?? 'unknown'}`,
            );
            await client.messageCopy(uids, destFolder.path, { uid: true });
            await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
            await client.messageDelete(uids, { uid: true });
          }
          moveSucceeded = true;
          moved += group.items.length;
          touchedDestFolderIds.add(destFolder.id);
        } finally {
          lock.release();
        }
      } finally {
        this.releaseClient(group.account.id);
        if (!moveSucceeded) {
          // Restore the rows we pre-deleted so the user doesn't lose the
          // local view of mail that still lives on the server.
          await this.prisma.client.mailMessage
            .createMany({
              data: snapshot.map((row) => ({
                id: row.id,
                accountId: row.accountId,
                folderId: row.folderId,
                uid: row.uid,
                messageId: row.messageId,
                subject: row.subject,
                fromAddress: row.fromAddress,
                fromName: row.fromName,
                toAddresses: row.toAddresses as Prisma.InputJsonValue,
                ccAddresses: row.ccAddresses as Prisma.InputJsonValue,
                bccAddresses: row.bccAddresses as Prisma.InputJsonValue,
                replyTo: row.replyTo,
                bodyTextPreview: row.bodyTextPreview,
                bodyText: row.bodyText,
                bodyHtml: row.bodyHtml,
                hasAttachments: row.hasAttachments,
                attachmentCount: row.attachmentCount,
                sizeBytes: row.sizeBytes,
                receivedAt: row.receivedAt,
                sentAt: row.sentAt,
                flags: row.flags as Prisma.InputJsonValue,
                isUnread: row.isUnread,
                isStarred: row.isStarred,
                isAnswered: row.isAnswered,
                seenPendingAt: row.seenPendingAt,
                starredPendingAt: row.starredPendingAt,
                inReplyTo: row.inReplyTo,
                references:
                  (row.references as Prisma.InputJsonValue) ?? Prisma.JsonNull,
              })),
              skipDuplicates: true,
            })
            .catch((err) => {
              this.logger.warn(
                `Failed to restore messages after bulk move failure count=${snapshot.length} message=${(err as Error)?.message ?? 'unknown'}`,
              );
            });
          skipped += group.items.length;
        }
      }
    }

    // One destination sync per touched destination folder so the moved rows
    // show up locally. Sequential rather than parallel - multiple parallel
    // syncs would each open a fresh connection and undo the batching we
    // just did.
    for (const folderId of touchedDestFolderIds) {
      const folder = await this.prisma.client.mailFolder.findUnique({
        where: { id: folderId },
        select: { accountId: true },
      });
      if (!folder) continue;
      try {
        await this.syncFolderMessages(folder.accountId, folderId);
      } catch (err) {
        this.logger.warn(
          `Post-bulk-move destination sync failed folderId=${folderId} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    return { moved, skipped };
  }

  /**
   * Bulk \\Deleted + EXPUNGE for many messages. Used by the "Permanently
   * delete" action in the multi-select bar (only surfaced inside Trash/Spam
   * - the controller enforces that constraint). One IMAP session per source
   * folder; one STORE + one EXPUNGE per group.
   */
  async bulkDeleteMessages(
    messageIds: string[],
  ): Promise<{ deleted: number; skipped: number }> {
    if (messageIds.length === 0) return { deleted: 0, skipped: 0 };

    const rows = await this.prisma.client.mailMessage.findMany({
      where: { id: { in: messageIds } },
      include: { account: true, folder: true },
    });

    const groups = new Map<
      string,
      {
        account: MailAccount;
        folder: MailFolder;
        items: { id: string; uid: bigint }[];
      }
    >();
    for (const row of rows) {
      const key = `${row.accountId}::${row.folderId}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = { account: row.account, folder: row.folder, items: [] };
        groups.set(key, bucket);
      }
      bucket.items.push({ id: row.id, uid: row.uid });
    }

    let deleted = 0;
    let skipped = 0;

    for (const group of groups.values()) {
      const client = await this.acquireClient(group.account);
      try {
        const lock = await client.getMailboxLock(group.folder.path);
        try {
          const uids = group.items.map((i) => i.uid.toString()).join(',');
          await client.messageFlagsAdd(uids, ['\\Deleted'], { uid: true });
          await client.messageDelete(uids, { uid: true });
          deleted += group.items.length;
        } finally {
          lock.release();
        }
      } catch (err) {
        this.logger.warn(
          `bulk delete failed for folderId=${group.folder.id} count=${group.items.length} message=${(err as Error)?.message ?? 'unknown'}`,
        );
        skipped += group.items.length;
        continue;
      } finally {
        this.releaseClient(group.account.id);
      }

      await this.prisma.client.mailMessage.deleteMany({
        where: { id: { in: group.items.map((i) => i.id) } },
      });
    }

    return { deleted, skipped };
  }

  /**
   * Bulk flag mutation across many messages. Groups by source folder so each
   * group is one connection + one STORE call covering every UID in the group.
   * Handles read/unread/star/unstar uniformly; the unread-count column on
   * each touched folder is recomputed from the post-update DB state.
   */
  async bulkSetFlag(
    messageIds: string[],
    op: 'read' | 'unread' | 'star' | 'unstar',
  ): Promise<{ updated: number; skipped: number }> {
    if (messageIds.length === 0) return { updated: 0, skipped: 0 };

    const rows = await this.prisma.client.mailMessage.findMany({
      where: { id: { in: messageIds } },
      include: { account: true, folder: true },
    });

    const groups = new Map<
      string,
      {
        account: MailAccount;
        folder: MailFolder;
        items: { id: string; uid: bigint; isUnread: boolean; isStarred: boolean; flags: Prisma.JsonValue }[];
      }
    >();
    for (const row of rows) {
      const key = `${row.accountId}::${row.folderId}`;
      let bucket = groups.get(key);
      if (!bucket) {
        bucket = { account: row.account, folder: row.folder, items: [] };
        groups.set(key, bucket);
      }
      bucket.items.push({
        id: row.id,
        uid: row.uid,
        isUnread: row.isUnread,
        isStarred: row.isStarred,
        flags: row.flags,
      });
    }

    const isSeen = op === 'read' || op === 'unread';
    const flagName = isSeen ? '\\Seen' : '\\Flagged';
    const addFlag = op === 'read' || op === 'star';

    let updated = 0;
    // Ids that resolved to no row at all (already expunged, or never ours).
    // A failed IMAP push is no longer counted here: the local flag did
    // change, so reporting it as skipped would contradict what the user sees.
    const skipped = messageIds.length - rows.length;
    const touchedFolderIds = new Set<string>();

    for (const group of groups.values()) {
      // Patch the local DB first (see setSeen for why). We don't recompute
      // mergeFlags row-by-row here - the reconcile pass rewrites the flags
      // JSON from the server anyway, and the important columns (isUnread /
      // isStarred) are what the UI reads.
      const ids = group.items.map((i) => i.id);
      // Pending until the server confirms; the reconcile pass re-sends it.
      const pendingAt = new Date();
      if (isSeen) {
        await this.prisma.client.mailMessage.updateMany({
          where: { id: { in: ids } },
          data: { isUnread: op === 'unread', seenPendingAt: pendingAt },
        });
      } else {
        await this.prisma.client.mailMessage.updateMany({
          where: { id: { in: ids } },
          data: { isStarred: op === 'star', starredPendingAt: pendingAt },
        });
      }
      updated += group.items.length;
      touchedFolderIds.add(group.folder.id);

      // Then push to IMAP. A failure here leaves the mail host out of step
      // with us until the next reconcile, but it no longer costs the user
      // their action.
      const client = await this.acquireClient(group.account).catch((err: unknown) => {
        this.logger.warn(
          `bulk setFlag connect failed for folderId=${group.folder.id} message=${(err as Error)?.message ?? 'unknown'}`,
        );
        return null;
      });
      if (!client) continue;
      try {
        const lock = await client.getMailboxLock(group.folder.path);
        try {
          const uids = group.items.map((i) => i.uid.toString()).join(',');
          await this.storeFlag(client, uids, flagName, addFlag);
        } finally {
          lock.release();
        }
        await this.clearPending(ids, isSeen ? 'seenPendingAt' : 'starredPendingAt', pendingAt);
      } catch (err) {
        this.logger.warn(
          `bulk setFlag push failed for folderId=${group.folder.id} count=${group.items.length} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      } finally {
        this.releaseClient(group.account.id);
      }
    }

    // Recompute unreadCount on each touched folder so the sidebar badge
    // converges with the new state without waiting for the next list call.
    // One grouped COUNT covers every touched folder; a folder with no unread
    // rows left has no bucket, which is the same 0 the per-folder count gave.
    if (isSeen && touchedFolderIds.size > 0) {
      const folderIds = [...touchedFolderIds];
      const unreadRows = await this.prisma.client.mailMessage.groupBy({
        by: ['folderId'],
        where: { folderId: { in: folderIds }, isUnread: true },
        _count: { _all: true },
      });
      const unreadByFolder = new Map(
        unreadRows.map((r) => [r.folderId, r._count._all]),
      );
      for (const folderId of folderIds) {
        await this.prisma.client.mailFolder.update({
          where: { id: folderId },
          data: { unreadCount: unreadByFolder.get(folderId) ?? 0 },
        });
      }
    }

    return { updated, skipped };
  }

  /** Fetch one message part by IMAP part id. Used by the attachment download
   *  endpoint to stream bytes directly to the HTTP response. */
  async fetchAttachment(
    accountId: string,
    folderPath: string,
    uid: bigint,
    partId: string,
    // Identity of the wanted attachment. Used to recompute the real IMAP part
    // number when the stored `partId` is a stale/legacy value (the historical
    // Content-ID bug) and the direct download fails - older mail synced before
    // the fix still carries a bad partId until it's re-fetched.
    hint?: { filename: string; contentType: string; contentId: string | null },
  ): Promise<{ content: Buffer | null; healedPartId: string | null }> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) return { content: null, healedPartId: null };

    const client = await this.acquireClient(account);
    try {
      const lock = await client.getMailboxLock(folderPath);
      try {
        // Download a MIME part, tolerating imapflow THROWING on a bad part
        // number (e.g. a legacy Content-ID partId) instead of returning empty.
        // Swallowing here is what turns the old 500 into a graceful fallback.
        const tryDownload = async (pid: string): Promise<Buffer | null> => {
          try {
            const part = await client.download(uid.toString(), pid, { uid: true });
            if (!part?.content) return null;
            const chunks: Buffer[] = [];
            for await (const chunk of part.content) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            return Buffer.concat(chunks);
          } catch {
            return null;
          }
        };

        // Happy path - the stored partId. Untouched for correctly-synced mail.
        const direct = await tryDownload(partId);
        if (direct) return { content: direct, healedPartId: null };

        // Fallback for legacy rows whose partId is stale/invalid: re-read the
        // live body structure, recompute the real IMAP part number, match it to
        // the wanted attachment, and retry. The corrected partId is returned so
        // the caller can heal the row for next time.
        if (!hint) return { content: null, healedPartId: null };
        let structure: BodyStructureNode | undefined;
        try {
          const msg = await client.fetchOne(
            uid.toString(),
            { bodyStructure: true },
            { uid: true },
          );
          structure =
            msg && typeof msg === 'object'
              ? (msg.bodyStructure as BodyStructureNode | undefined)
              : undefined;
        } catch {
          structure = undefined;
        }
        if (!structure) return { content: null, healedPartId: null };
        const { attachments } = describeBodyStructure(structure);
        const match =
          attachments.find(
            (a) => a.filename === hint.filename && a.contentType === hint.contentType,
          ) ??
          (hint.contentId
            ? attachments.find((a) => a.contentId === hint.contentId)
            : undefined) ??
          attachments.find((a) => a.filename === hint.filename);
        if (!match || match.partId === partId) {
          return { content: null, healedPartId: null };
        }
        const healed = await tryDownload(match.partId);
        return { content: healed, healedPartId: healed ? match.partId : null };
      } finally {
        lock.release();
      }
    } finally {
      this.releaseClient(account.id);
    }
  }

  private mergeFlags(existing: string[], flag: string, present: boolean): string[] {
    const set = new Set(existing);
    if (present) set.add(flag);
    else set.delete(flag);
    return Array.from(set);
  }

  /**
   * Insert or update a single MailMessage row from an imapflow fetch result.
   * Returns 'inserted' | 'updated' | 'skipped'. Body parts are fetched lazily
   * so we don't pull megabytes of HTML for the list-view first paint.
   */
  private async upsertMessage(
    accountId: string,
    folderId: string,
    msg: FetchMessageObject,
    client: ImapFlow,
    folderPath: string,
    /** Pre-fetched text parts for a message too large to fetch whole. */
    textBodies?: TextBodies,
  ): Promise<UpsertMessageResult> {
    if (!msg.uid) return { status: 'skipped' };

    const envelope = msg.envelope;
    const from = envelope?.from?.[0];
    const fromAddress = from?.address ?? '';
    if (!fromAddress) return { status: 'skipped' }; // pathological - every real message has a From

    const subject = envelope?.subject ?? '';
    const flags = Array.from(msg.flags ?? []);
    let isUnread = !flags.includes('\\Seen');
    let isStarred = flags.includes('\\Flagged');
    const isAnswered = flags.includes('\\Answered');
    const receivedAt = msg.internalDate ?? new Date();
    const sentAt = envelope?.date ?? receivedAt;
    const sizeBytes = msg.size ?? 0;

    const toAddresses = (envelope?.to ?? []).map((a: { address?: string }) => a.address ?? '').filter(Boolean);
    const ccAddresses = (envelope?.cc ?? []).map((a: { address?: string }) => a.address ?? '').filter(Boolean);
    const bccAddresses = (envelope?.bcc ?? []).map((a: { address?: string }) => a.address ?? '').filter(Boolean);

    const messageId = envelope?.messageId ?? null;
    const inReplyTo = envelope?.inReplyTo ?? null;

    const { textPreview, attachments } = describeBodyStructure(msg.bodyStructure as BodyStructureNode | undefined);

    const existing = await this.prisma.client.mailMessage.findUnique({
      where: { accountId_folderId_uid: { accountId, folderId, uid: BigInt(msg.uid) } },
    });

    if (existing) {
      // A read/star change the server has not confirmed yet keeps our state;
      // the reconcile pass re-sends it (see mail-flag-reconcile.ts).
      if (existing.seenPendingAt) isUnread = existing.isUnread;
      if (existing.starredPendingAt) isStarred = existing.isStarred;
      // Flag updates always. Plus a self-healing attachment patch: if the
      // existing row's stored attachment metadata doesn't match what the
      // current IMAP body-structure says (legacy rows written before the
      // appendToSent attachment-parsing fix, body-structure key-name fix,
      // manual data fixups, etc.), wipe and re-create the MailAttachment
      // rows so the reader UI surfaces them.
      //
      // We heal on EITHER count drift OR partId drift. The partId check
      // catches the historical bug where every received attachment was
      // stored with partId="<content-id>" or "1" because we read the
      // wrong key off the body-structure object - counts matched but
      // downloads 404ed because IMAP can't FETCH by Content-ID.
      const newPartIds = attachments.map((a) => a.partId);
      const existingAtts =
        attachments.length > 0
          ? await this.prisma.client.mailAttachment.findMany({
              where: { messageId: existing.id },
              select: { partId: true, filename: true },
              orderBy: { createdAt: 'asc' },
            })
          : [];
      const existingPartIds = existingAtts.map((a) => a.partId);
      const partIdsDrifted =
        attachments.length > 0 &&
        (existingPartIds.length !== newPartIds.length ||
          existingPartIds.some((p, i) => p !== newPartIds[i]));
      const needsAttachmentHeal =
        existing.attachmentCount !== attachments.length ||
        existing.hasAttachments !== (attachments.length > 0) ||
        partIdsDrifted;
      if (needsAttachmentHeal) {
        await this.prisma.client.$transaction(async (tx) => {
          await tx.mailMessage.update({
            where: { id: existing.id },
            data: {
              flags: flags as unknown as Prisma.InputJsonValue,
              isUnread,
              isStarred,
              isAnswered,
              hasAttachments: attachments.length > 0,
              attachmentCount: attachments.length,
            },
          });
          await tx.mailAttachment.deleteMany({
            where: { messageId: existing.id },
          });
          if (attachments.length > 0) {
            await tx.mailAttachment.createMany({
              data: attachments.map((a) => ({
                messageId: existing.id,
                partId: a.partId,
                filename: a.filename,
                contentType: a.contentType,
                sizeBytes: a.size,
                isInline: a.isInline,
                contentId: a.contentId,
              })),
            });
          }
        });
        this.logger.log(
          `Healed attachment metadata accountId=${accountId} uid=${msg.uid} count=${attachments.length}`,
        );
      } else {
        await this.prisma.client.mailMessage.update({
          where: { id: existing.id },
          data: {
            flags: flags as unknown as Prisma.InputJsonValue,
            isUnread,
            isStarred,
            isAnswered,
          },
        });
      }
      return { status: 'updated' };
    }

    // Parse the body from the source that was already fetched inline by
    // the outer sync loop. No extra IMAP commands here - that's what was
    // tripping the socket timeout previously.
    let bodyTextPreview = '';
    let bodyText: string | null = null;
    let bodyHtml: string | null = null;

    const raw =
      msg && typeof msg === 'object' && 'source' in msg
        ? ((msg as { source?: Buffer }).source ?? null)
        : null;
    if (raw) {
      try {
        const { simpleParser } = await import('mailparser');
        const parsed = await simpleParser(raw);
        const t = (parsed.text ?? '').trim();
        bodyTextPreview = t.slice(0, 200);
        bodyText = t.slice(0, 1_000_000); // cap at 1MB
        bodyHtml = typeof parsed.html === 'string' ? parsed.html.slice(0, 2_000_000) : null;
      } catch (err) {
        this.logger.warn(
          `Body parse failed accountId=${accountId} uid=${msg.uid} folder=${folderPath} message=${(err as Error)?.message ?? 'unknown'}`,
        );
        bodyTextPreview = textPreview;
      }
    } else if (textBodies && (textBodies.text || textBodies.html)) {
      const t = (textBodies.text ?? '').trim();
      bodyText = t ? t.slice(0, 1_000_000) : null;
      bodyHtml = textBodies.html ? textBodies.html.slice(0, 2_000_000) : null;
      const previewSource = t || (textBodies.html ?? '').replace(/<[^>]+>/g, ' ');
      bodyTextPreview = previewSource.replace(/\s+/g, ' ').trim().slice(0, 200);
    } else {
      bodyTextPreview = textPreview;
    }

    const created = await this.prisma.client.mailMessage.create({
      data: {
        accountId,
        folderId,
        uid: BigInt(msg.uid),
        messageId,
        subject,
        fromAddress,
        fromName: from?.name ?? null,
        toAddresses: toAddresses as unknown as Prisma.InputJsonValue,
        ccAddresses: ccAddresses as unknown as Prisma.InputJsonValue,
        bccAddresses: bccAddresses as unknown as Prisma.InputJsonValue,
        replyTo: envelope?.replyTo?.[0]?.address ?? null,
        bodyTextPreview,
        bodyText,
        bodyHtml,
        hasAttachments: attachments.length > 0,
        attachmentCount: attachments.length,
        sizeBytes,
        receivedAt,
        sentAt,
        flags: flags as unknown as Prisma.InputJsonValue,
        isUnread,
        isStarred,
        isAnswered,
        inReplyTo,
        references: Prisma.JsonNull,
      },
    });

    if (attachments.length > 0) {
      await this.prisma.client.mailAttachment.createMany({
        data: attachments.map((a) => ({
          messageId: created.id,
          partId: a.partId,
          filename: a.filename,
          contentType: a.contentType,
          sizeBytes: a.size,
          isInline: a.isInline,
          contentId: a.contentId,
        })),
      });
    }

    return {
      status: 'inserted',
      created: {
        id: created.id,
        subject,
        fromName: from?.name ?? null,
        fromAddress,
      },
    };
  }
}

interface UpsertMessageResult {
  status: 'inserted' | 'updated' | 'skipped';
  created?: {
    id: string;
    subject: string;
    fromName: string | null;
    fromAddress: string;
  };
}

interface BodyStructureNode {
  type?: string;
  subtype?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  /**
   * IMAP MIME part number, e.g. "1", "2", "2.1". This is the field that
   * `client.download(uid, part)` accepts. ImapFlow's MessageStructureObject
   * names it `part` (NOT `partID` - earlier versions of our code read the
   * wrong key and ended up with `undefined` for every attachment, which
   * then fell back to the Content-ID and broke every download).
   */
  part?: string;
  /** Legacy alias kept for compatibility with older imapflow versions. */
  partID?: string;
  /** Content-ID - used for inline `cid:` references in HTML bodies. NOT a
   *  valid IMAP part number, so never use it for fetch. */
  id?: string;
  childNodes?: BodyStructureNode[];
  size?: number;
}

function describeBodyStructure(
  node: BodyStructureNode | undefined,
): { textPreview: string; attachments: { partId: string; filename: string; contentType: string; size: number; isInline: boolean; contentId: string | null }[] } {
  const attachments: { partId: string; filename: string; contentType: string; size: number; isInline: boolean; contentId: string | null }[] = [];
  if (!node) return { textPreview: '', attachments };

  walk(node);
  return { textPreview: '', attachments };

  function walk(n: BodyStructureNode) {
    if (n.childNodes && n.childNodes.length > 0) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const disposition = (n.disposition ?? '').toLowerCase();
    const isAttachment = disposition === 'attachment' || (n.dispositionParameters?.filename != null);
    const isInline = disposition === 'inline';
    if (isAttachment || (isInline && n.id != null)) {
      const filename =
        n.dispositionParameters?.filename ??
        n.parameters?.name ??
        `untitled.${n.subtype ?? 'bin'}`;
      const contentType = `${n.type ?? 'application'}/${n.subtype ?? 'octet-stream'}`;
      // Prefer imapflow's `part` (e.g. "2", "2.1") which is what
      // `client.download(uid, part)` actually accepts. Falling through to
      // `partID` keeps compatibility with hypothetical older clients;
      // `id` (Content-ID like `<abc@host>`) is intentionally NOT a
      // fallback - earlier code did this and every attachment download
      // 404ed because the IMAP server rejects Content-IDs as part
      // numbers.
      const partId = n.part ?? n.partID ?? '1';
      attachments.push({
        partId,
        filename,
        contentType,
        size: n.size ?? 0,
        isInline,
        contentId: n.id ?? null,
      });
    }
  }
}

function roleFromFolder(folder: ListResponse): MailFolder['role'] {
  // 1. SPECIAL-USE flags (RFC 6154) - preferred when the server advertises
  //    them. Outlook / Gmail / FastMail set these reliably.
  const flags = new Set(
    Array.from(folder.flags ?? []).map((f) => String(f).toUpperCase()),
  );
  const su = folder.specialUse?.toUpperCase();

  if (su === '\\INBOX' || flags.has('\\INBOX') || folder.path.toUpperCase() === 'INBOX') return 'INBOX';
  if (su === '\\SENT' || flags.has('\\SENT')) return 'SENT';
  if (su === '\\DRAFTS' || flags.has('\\DRAFTS')) return 'DRAFTS';
  if (su === '\\TRASH' || flags.has('\\TRASH')) return 'TRASH';
  if (su === '\\JUNK' || flags.has('\\JUNK')) return 'SPAM';
  if (su === '\\ARCHIVE' || flags.has('\\ARCHIVE')) return 'ARCHIVE';
  if (su === '\\ALL' || flags.has('\\ALL')) return 'ALL';
  if (su === '\\FLAGGED' || flags.has('\\FLAGGED')) return 'FLAGGED';

  // 2. Fallback: name-based detection. cPanel / Courier / Dovecot Maildir
  //    layouts use hierarchical paths like INBOX.Sent, INBOX.Drafts,
  //    INBOX.Trash - and many of those servers do NOT advertise
  //    SPECIAL-USE. Map the LAST path segment to a canonical role.
  const delimiter = folder.delimiter || '/';
  const segments = folder.path.split(delimiter);
  const tail = (segments[segments.length - 1] ?? folder.path).toLowerCase().trim();

  if (tail === 'inbox') return 'INBOX';
  if (['sent', 'sent items', 'sent messages', 'sent mail', 'sent-mail'].includes(tail)) return 'SENT';
  if (['drafts', 'draft'].includes(tail)) return 'DRAFTS';
  if (['trash', 'deleted', 'deleted items', 'deleted messages', 'bin'].includes(tail)) return 'TRASH';
  if (['junk', 'spam', 'junk mail', 'junk e-mail'].includes(tail)) return 'SPAM';
  if (['archive', 'archives', 'all mail'].includes(tail)) return 'ARCHIVE';

  return null;
}

function positionFor(role: MailFolder['role']): number {
  switch (role) {
    case 'INBOX':
      return 0;
    case 'SENT':
      return 10;
    case 'DRAFTS':
      return 20;
    case 'ARCHIVE':
      return 30;
    case 'SPAM':
      return 40;
    case 'TRASH':
      return 50;
    default:
      return 100;
  }
}
