import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { PROCESS_ROLE, type ProcessRole, runsBackgroundWork } from '../common/process-role';
import { ImapSyncService, type PinHandlers } from './imap-sync.service';
import { MailEventsService } from './mail-events.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Per-account IMAP IDLE watcher. Keeps each ACTIVE MailAccount's pooled
 * connection open, parked on INBOX in IDLE mode. When the server signals
 * `EXISTS` (new mail arrived) or `EXPUNGE` (something moved/deleted), we
 * trigger a forward-only sync immediately - typically the row lands in the
 * DB within 1–2 seconds of the mail hitting the server.
 *
 * IMAP IDLE only watches one mailbox per connection. We pick INBOX because
 * that's where new mail arrives; other folders sync on user navigation via
 * the existing `maybeBackgroundSync` path triggered by `listMessages`.
 *
 * RFC 2177 caps IDLE at 29 minutes; imapflow handles the periodic refresh
 * internally. We just need to keep the connection alive and reconnect on
 * disconnect with exponential backoff.
 *
 * Resilience model (three layers, so real-time mail self-heals without an
 * API restart):
 *   1. Each watcher reconnects with jittered, capped exponential backoff and
 *      NEVER gives up - a multi-hour outage (e.g. the outbound-firewall block
 *      we hit on prod) recovers on its own once connectivity returns. Every
 *      login goes through `MailHostGovernor`, whose per-host circuit breaker
 *      and login spacing stop a mass drop from turning into a reconnect
 *      storm. Logs are throttled to one line per down-streak.
 *   2. A 60 s supervisor (`@Interval`) reconciles watchers against the set
 *      of ACTIVE accounts and recycles any whose connection imapflow reports
 *      as no longer `usable` - a backstop if a watcher's own loop ever wedges
 *      or a connection goes half-open without emitting `close`.
 *   3. `maxIdleTime` makes imapflow break-and-restart IDLE every few minutes,
 *      which keeps NAT/firewall mappings warm and surfaces a dead socket far
 *      sooner than TCP keepalive would.
 *
 * Single instance: watchers run only in the process that does background
 * work (ROLE=all or ROLE=worker, see common/process-role.ts). In ROLE=api
 * this service never starts a watcher, and its @Interval supervisors are off.
 */
@Injectable()
export class ImapIdleService
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(ImapIdleService.name);
  private readonly watchers = new Map<string, Watcher>();
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ImapSyncService,
    private readonly events: MailEventsService,
    @Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all',
  ) {}

  /** False in ROLE=api: IDLE belongs to the single background process. */
  get ownsWatchers(): boolean {
    return runsBackgroundWork(this.role);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.ownsWatchers) {
      this.logger.log(
        'IMAP IDLE watchers are off in this process (ROLE=api); the worker runs them.',
      );
      return;
    }
    // Defer slightly so HTTP routes are up first - boot logs stay readable
    // and any transient IDLE failures don't drown out request logs.
    setTimeout(() => {
      void this.refreshWatchers().catch((err) => {
        this.logger.error(
          `Initial IDLE refresh failed message=${(err as Error)?.message ?? 'unknown'}`,
        );
      });
    }, 2_000);
  }

  /**
   * Stop watchers alongside `ImapSyncService.onModuleDestroy` (Nest runs the
   * two together), so no reconnect timer fires into a draining pool. Both do
   * their state changes before their first await, and the pool ignores
   * 'close' once destroyed, so the order between them does not matter.
   * Idempotent: the application-shutdown hook runs it again.
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const stops = Array.from(this.watchers.values()).map((w) => w.stop());
    this.watchers.clear();
    await Promise.allSettled(stops);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.onModuleDestroy();
  }

  /**
   * Reconcile watchers against the current set of ACTIVE accounts. Called on
   * boot, after an account is verified, and after an account is removed or
   * disabled. Cheap to call repeatedly - already-running watchers are not
   * disturbed.
   *
   * Concurrent callers (boot + verify-hook + the 60 s supervisor can overlap)
   * are coalesced onto a single in-flight run. Without this, two reconciles
   * interleaving across the `findMany` await could both miss an existing
   * watcher and start a second one for the same account, leaking a duplicate
   * IMAP login. An account activated mid-run is picked up by the next call
   * (at worst the next supervisor tick, <=60 s later).
   */
  /**
   * Drop an account's watcher so the next `refreshWatchers` starts a fresh
   * one. Used after credentials are verified: a watcher that backed off on
   * the old password may be asleep for up to ~10 min. `stop()` only removes
   * its own pin, and the new watcher re-pins the live pooled connection
   * without another login.
   */
  restartWatcher(accountId: string): void {
    const watcher = this.watchers.get(accountId);
    if (!watcher) return;
    this.watchers.delete(accountId);
    void watcher.stop();
  }

  refreshWatchers(): Promise<void> {
    if (!this.ownsWatchers) return Promise.resolve();
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.reconcileWatchers().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private refreshInFlight: Promise<void> | null = null;

  private async reconcileWatchers(): Promise<void> {
    if (this.shuttingDown) return;
    const accounts = await this.prisma.client.mailAccount.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    const wanted = new Set(accounts.map((a) => a.id));

    // Stop watchers whose account is no longer active.
    for (const [accountId, watcher] of this.watchers) {
      if (!wanted.has(accountId)) {
        this.watchers.delete(accountId);
        void watcher.stop();
      }
    }

    // Start watchers for newly-active accounts.
    for (const accountId of wanted) {
      if (this.watchers.has(accountId)) continue;
      const w = new Watcher(accountId, {
        prisma: this.prisma,
        sync: this.sync,
        events: this.events,
        logger: this.logger,
      });
      this.watchers.set(accountId, w);
      // A little jitter; the governor's login spacing staggers the rest.
      w.start(Math.floor(Math.random() * 5_000));
    }
  }

  /**
   * Self-healing supervisor. Runs every 60 s: recycles any watcher whose
   * connection has gone unusable (and isn't already mid-reconnect), then
   * reconciles against the live ACTIVE-account set so a fresh watcher is
   * spun up for anything missing one. This is the backstop that guarantees
   * real-time mail recovers without an API restart even if a watcher's own
   * reconnect loop wedges or a connection silently goes half-open.
   *
   * Dropping a wedged entry from the map and then calling `refreshWatchers`
   * re-creates a fresh watcher for it. `stop()` flips the watcher's `stopped`
   * flag synchronously, so the orphaned instance can't keep reconnecting in
   * the background after we drop it.
   */
  @Interval('imap-idle-supervisor', 60_000)
  async supervise(): Promise<void> {
    if (this.shuttingDown || !this.ownsWatchers) return;
    for (const [accountId, watcher] of this.watchers) {
      if (watcher.isUnhealthy()) {
        this.watchers.delete(accountId);
        void watcher.stop();
      }
    }
    await this.refreshWatchers().catch((err) => {
      this.logger.warn(
        `IDLE supervisor refresh failed message=${(err as Error)?.message ?? 'unknown'}`,
      );
    });
  }

  /**
   * Server-side backstop. IDLE is the real-time path, but it only reacts to
   * events it sees, and the page poll only runs while someone has the mail
   * page open. If both miss a message (a half-open IDLE socket, a missed
   * EXISTS, nobody looking), it used to sit on the server with no row and no
   * notification. Every 5 minutes, sync INBOX for any ACTIVE account that has
   * not synced in that window. Two accounts at a time, through the shared
   * connection pool, so this never becomes a login storm. Accounts backing
   * off after connection failures fail fast inside ImapSyncService.
   */
  private backstopRunning = false;
  @Interval('mail-backstop', 5 * 60_000)
  async backstopSync(): Promise<void> {
    if (this.shuttingDown || this.backstopRunning || !this.ownsWatchers) return;
    this.backstopRunning = true;
    try {
      const staleBefore = new Date(Date.now() - 5 * 60_000);
      const accounts = await this.prisma.client.mailAccount.findMany({
        where: {
          status: 'ACTIVE',
          deletedAt: null,
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
        },
        select: { id: true },
      });
      const queue = accounts.map((a) => a.id);
      const worker = async () => {
        while (queue.length > 0 && !this.shuttingDown) {
          const accountId = queue.shift()!;
          const inbox = await this.prisma.client.mailFolder.findFirst({
            where: { accountId, role: 'INBOX' },
            orderBy: { position: 'asc' },
            select: { id: true },
          });
          if (!inbox) continue;
          try {
            const result = await this.sync.syncFolderMessages(accountId, inbox.id);
            if (result.inserted > 0) {
              this.logger.log(
                `Backstop sync imported mail accountId=${accountId} inserted=${result.inserted}`,
              );
              const account = await this.prisma.client.mailAccount.findUnique({
                where: { id: accountId },
                select: { userId: true },
              });
              if (account) {
                this.events.emit({
                  kind: 'folder-updated',
                  userId: account.userId,
                  accountId,
                  folderId: inbox.id,
                  inserted: result.inserted,
                });
              }
            }
          } catch (err) {
            this.logger.debug(
              `Backstop sync skipped accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } finally {
      this.backstopRunning = false;
    }
  }
}

interface WatcherDeps {
  prisma: PrismaService;
  sync: ImapSyncService;
  events: MailEventsService;
  logger: Logger;
}

/**
 * Manages a single account's IDLE lifecycle. The watcher owns no connection:
 * it pins the account's pooled connection (see `ImapSyncService.pinClient`),
 * so one login per mailbox serves IDLE, syncs, sends and flag changes.
 */
class Watcher {
  private stopped = false;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** True while we're in a sustained reconnect streak. Gates the per-attempt
   *  close logs so a multi-hour outage produces one "down" line and one
   *  "recovered" line, not hundreds. */
  private degraded = false;
  /** Identity of this watcher's pin, so stopping never unpins a successor. */
  private readonly handlers: PinHandlers;

  constructor(
    private readonly accountId: string,
    private readonly deps: WatcherDeps,
  ) {
    this.handlers = {
      inboxPath: 'INBOX',
      // EXISTS is the canonical "new mail arrived" signal. EXPUNGE means a
      // message was moved or deleted and the folder needs to drop the row.
      onExists: () => void this.triggerSync('exists'),
      onExpunge: () => void this.triggerSync('expunge'),
      onClose: () => this.handleClose(),
    };
  }

  /** Start after `delayMs`, so watchers created together do not log in together. */
  start(delayMs = 0): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attempt();
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.handlers.cancelled = true;
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.deps.sync.unpinClient(this.accountId, this.handlers);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.connect();
    } catch (err) {
      this.scheduleReconnect(err);
    }
  }

  private async connect(): Promise<void> {
    const account = await this.deps.prisma.client.mailAccount.findUnique({
      where: { id: this.accountId },
    });
    if (!account || account.deletedAt || account.status !== 'ACTIVE') {
      // Removed or disabled. Release our pin (if a dropped connection brought
      // us here) so the pooled connection can idle-close.
      this.stopped = true;
      this.connected = false;
      this.deps.sync.unpinClient(this.accountId, this.handlers);
      return;
    }
    const inbox = await this.deps.prisma.client.mailFolder.findFirst({
      where: { accountId: this.accountId, role: 'INBOX' },
      orderBy: { position: 'asc' },
      select: { path: true },
    });
    this.handlers.inboxPath = inbox?.path ?? 'INBOX';

    // Stopped while we looked the account up (e.g. it was just removed).
    if (this.stopped) return;
    // Logs in through the pool and the host governor, which also keep the
    // SSRF guard and every backoff in one place.
    await this.deps.sync.pinClient(account, this.handlers);
    if (this.stopped) {
      // Stopped while the login was in flight.
      this.deps.sync.unpinClient(this.accountId, this.handlers);
      return;
    }
    this.connected = true;
    if (this.degraded) {
      this.deps.logger.log(
        `IDLE recovered accountId=${this.accountId} after ${this.reconnectAttempt} attempt(s)`,
      );
    } else {
      this.deps.logger.log(`IDLE connected accountId=${this.accountId}`);
    }
    this.degraded = false;
    this.reconnectAttempt = 0;

    // Catch up on anything that arrived while this watcher was disconnected
    // (API restart on deploy, network drop). IDLE only reports changes AFTER
    // it starts watching, so without this a message delivered during the gap
    // waited for the NEXT new message, or for someone to open the mail page.
    // It runs on the pinned connection, so it costs no login; the short
    // jitter just keeps a boot's worth of syncs from landing together.
    setTimeout(
      () => {
        if (!this.stopped) void this.triggerSync('reconnect');
      },
      1_000 + Math.floor(Math.random() * 9_000),
    );
  }

  private handleClose(): void {
    if (this.stopped) return;
    this.connected = false;
    if (!this.degraded) {
      this.deps.logger.log(`IDLE connection closed accountId=${this.accountId}, reconnecting…`);
    }
    this.scheduleReconnect();
  }

  /** Run a forward-only INBOX sync and emit a push event. Guarded so we don't
   *  stack overlapping syncs if a server sends a burst of EXISTS. */
  private syncing = false;
  private syncPending = false;
  private async triggerSync(reason: string): Promise<void> {
    if (this.syncing) {
      this.syncPending = true;
      return;
    }
    this.syncing = true;
    try {
      const inbox = await this.deps.prisma.client.mailFolder.findFirst({
        where: { accountId: this.accountId, role: 'INBOX' },
        orderBy: { position: 'asc' },
      });
      if (!inbox) return;
      const result = await this.deps.sync.syncFolderMessages(this.accountId, inbox.id);
      const account = await this.deps.prisma.client.mailAccount.findUnique({
        where: { id: this.accountId },
        select: { userId: true },
      });
      if (account) {
        this.deps.events.emit({
          kind: 'folder-updated',
          userId: account.userId,
          accountId: this.accountId,
          folderId: inbox.id,
          inserted: result.inserted,
        });
      }
      if (result.inserted > 0 || result.updated > 0) {
        this.deps.logger.log(
          `IDLE push accountId=${this.accountId} reason=${reason} inserted=${result.inserted} updated=${result.updated}`,
        );
      }
    } catch (err) {
      this.deps.logger.warn(
        `IDLE sync failed accountId=${this.accountId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    } finally {
      this.syncing = false;
      if (this.syncPending) {
        this.syncPending = false;
        void this.triggerSync('coalesced');
      }
    }
  }

  /** Ceiling for the exponential reconnect backoff. We deliberately never
   *  stop retrying - a multi-hour outage (the 4-hour outbound-firewall block
   *  we hit on prod) must recover on its own, not stay dead until an API
   *  restart. While the host's circuit is open an attempt fails fast inside
   *  the governor without touching the network, so a long outage churns
   *  neither logins nor logs. */
  private static readonly MAX_BACKOFF_MS = 120_000;

  private scheduleReconnect(err?: unknown): void {
    if (this.stopped) return;
    // Guard against double-scheduling when a failed attempt and a 'close'
    // both report the same disconnect.
    if (this.reconnectTimer) return;
    this.reconnectAttempt++;
    // Jittered, so watchers that dropped together do not retry together:
    // lockstep retries from one IP are what the mail host's firewall blocks.
    const base = Math.min(
      Watcher.MAX_BACKOFF_MS,
      5_000 * 2 ** Math.min(5, this.reconnectAttempt - 1),
    );
    let delay = base / 2 + Math.random() * (base / 2);
    // No point waking before the governor would let the login through.
    const gate = this.deps.sync.msUntilConnectAllowed(this.accountId);
    if (gate > 0) delay = Math.max(delay, gate + Math.random() * 15_000);
    // Announce the down-streak exactly once. Recovery is logged from
    // connect(); everything in between stays quiet.
    if (err && !this.degraded) {
      this.degraded = true;
      this.deps.logger.warn(
        `IDLE down accountId=${this.accountId} - retrying with backoff (<=${Math.round(
          Watcher.MAX_BACKOFF_MS / 1000,
        )}s, longer while the mail host is backing off) until it recovers. First error: ${
          (err as Error)?.message ?? 'unknown'
        }`,
      );
    }
    this.start(Math.round(delay));
  }

  /**
   * Health probe for the supervisor. Returns true when this watcher should
   * be torn down and re-created:
   *   - it has been explicitly stopped, or
   *   - it believes it's connected but its pinned connection is gone or
   *     imapflow reports it unusable, AND no reconnect is already pending
   *     (the half-open case that never emitted 'close').
   * An in-flight connect or a scheduled reconnect counts as healthy so the
   * supervisor never interrupts recovery already underway.
   */
  isUnhealthy(): boolean {
    if (this.stopped) return true;
    if (this.reconnectTimer) return false;
    if (!this.connected) return false;
    return !this.deps.sync.isPinnedUsable(this.accountId);
  }
}
