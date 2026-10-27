import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Prisma } from '@botss/database';
import type {
  ListMailMessagesQuery,
  MailFolder,
  MailFolderResyncQueued,
  MailMessage,
  MailMessageListItem,
  RecipientSuggestionsQuery,
} from '@botss/shared-types';

import { ImapSyncService } from './imap-sync.service';
import {
  MAIL_RESYNC_JOB_OPTIONS,
  MAIL_RESYNC_QUEUE,
  type MailJobData,
  mailResyncJobId,
} from './mail.queue';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { sanitizeMailHtml } from './mail-sanitize';

/**
 * Read-side queries for the mail UI: folder list, message list (cursor-
 * paginated, optional filters), message detail (with sanitized HTML), and
 * flag mutations that round-trip through IMAP.
 *
 * Ownership is enforced at every entry point: a user can only see messages
 * belonging to MailAccounts they own. Workspace admins do not get access to
 * other users' mailboxes.
 */
@Injectable()
export class MailReadService {
  private readonly logger = new Logger(MailReadService.name);

  // ---- Log throttling -------------------------------------------------
  // The fallback-poll and manual-refresh paths can both fire frequently
  // (the mail list now auto-refreshes every 10 s, and the refresh button
  // can be mashed while waiting on a slow OTP). A broken account would
  // otherwise emit a warning on every single tick. Collapse repeats to at
  // most one line per minute per key so the logs stay readable while still
  // surfacing a persistent problem.
  private readonly lastLoggedAt = new Map<string, number>();
  private static readonly LOG_THROTTLE_MS = 60_000;
  private logThrottled(key: string, level: 'warn' | 'error', message: string): void {
    const now = Date.now();
    if (now - (this.lastLoggedAt.get(key) ?? 0) < MailReadService.LOG_THROTTLE_MS) {
      return;
    }
    this.lastLoggedAt.set(key, now);
    this.logger[level](message);
  }

  // ---- Manual-refresh throttle ---------------------------------------
  // The refresh button forces a real IMAP fetch (bypassing the 60 s
  // background cooldown), but we still debounce it to one actual fetch
  // every 5 s per account. If the user spams the button because the OTP
  // hasn't landed yet, the extra clicks return immediately without opening
  // another IMAP roundtrip.
  private readonly lastManualSyncAt = new Map<string, number>();
  private static readonly MANUAL_SYNC_COOLDOWN_MS = 5_000;

  // Recent sent messages scanned per recipient-suggestion lookup. Bounds the
  // work an autocomplete keystroke can trigger on a large Sent folder.
  private static readonly SUGGESTION_SCAN_LIMIT = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: ImapSyncService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
    @InjectQueue(MAIL_RESYNC_QUEUE) private readonly queue: Queue<MailJobData>,
  ) {}

  /** One folder resync per user per folder in this window (seconds). */
  static readonly RESYNC_WINDOW_SECONDS = 120;
  /** How long the rate-limit claim may wait on Redis before giving up. */
  static readonly RESYNC_REDIS_TIMEOUT_MS = 2_000;

  async listFolders(userId: string, accountId: string): Promise<{ items: MailFolder[] }> {
    await this.assertAccountOwner(userId, accountId);
    const rows = await this.prisma.client.mailFolder.findMany({
      where: { accountId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
    // Compute unreadCount from our own DB rather than trusting the stored
    // counter. The stored value is fed by IMAP STATUS, which reports the
    // *server's* unseen total - including historical mail that's never
    // been imported into the CRM (forward-only sync). Counting the rows
    // we actually display keeps the badge in sync with what the user can
    // see and respond to.
    const unreadGroups =
      rows.length > 0
        ? await this.prisma.client.mailMessage.groupBy({
            by: ['folderId'],
            where: { folderId: { in: rows.map((r) => r.id) }, isUnread: true },
            _count: { _all: true },
          })
        : [];
    const unreadByFolder = new Map<string, number>();
    for (const g of unreadGroups) unreadByFolder.set(g.folderId, g._count._all);
    return {
      items: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        path: r.path,
        name: r.name,
        role: r.role,
        delimiter: r.delimiter,
        totalCount: r.totalCount,
        unreadCount: unreadByFolder.get(r.id) ?? 0,
        position: r.position,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  }

  async listMessages(
    userId: string,
    q: ListMailMessagesQuery,
  ): Promise<{ items: MailMessageListItem[]; nextCursor: string | null }> {
    // Either accountId or folderId is required; both filter independently.
    if (!q.accountId && !q.folderId) {
      throw new NotFoundException({
        title: 'Missing scope',
        status: 400,
        detail: 'Provide accountId or folderId.',
      });
    }

    if (q.accountId) await this.assertAccountOwner(userId, q.accountId);
    let resolvedAccountId: string | null = q.accountId ?? null;
    if (q.folderId) {
      const folder = await this.prisma.client.mailFolder.findUnique({
        where: { id: q.folderId },
        select: { accountId: true },
      });
      if (!folder) throw new NotFoundException({ title: 'Folder not found', status: 404 });
      await this.assertAccountOwner(userId, folder.accountId);
      resolvedAccountId = folder.accountId;
    }

    // Replace the old manual "Sync now" button with an implicit background
    // sync. Every list call checks lastSyncedAt; if stale (>30 s), kick a
    // fire-and-forget IMAP sync. Combined with the 60 s frontend polling on
    // `useMailMessages`, this pulls new mail in roughly real time without
    // any user-visible chrome and without an IMAP IDLE connection.
    //
    // We pass through the folderId the user is currently looking at so the
    // background sync targets THAT folder (in addition to INBOX). Previously
    // only INBOX was synced, which meant moves into Archive/Trash/Spam - or
    // mail filed there by server-side rules - never showed up locally until
    // the user manually re-verified the account.
    if (resolvedAccountId) {
      void this.maybeBackgroundSync(resolvedAccountId, q.folderId ?? null).catch(
        (err) => {
          this.logThrottled(
            `bg-sync:${resolvedAccountId}`,
            'warn',
            `Background sync failed accountId=${resolvedAccountId} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        },
      );
    }

    const where: Prisma.MailMessageWhereInput = {};
    if (q.folderId) where.folderId = q.folderId;
    if (q.accountId) where.accountId = q.accountId;
    if (q.unreadOnly) where.isUnread = true;
    if (q.starredOnly) where.isStarred = true;
    if (q.search) {
      const s = q.search;
      where.OR = [
        { subject: { contains: s, mode: 'insensitive' } },
        { fromAddress: { contains: s, mode: 'insensitive' } },
        { fromName: { contains: s, mode: 'insensitive' } },
        // Same columns as global search. The full `bodyText` is not searched:
        // it has no trigram index (it would be huge and slow every sync), so
        // one unindexed OR branch made every mail search a full scan.
        { bodyTextPreview: { contains: s, mode: 'insensitive' } },
      ];
    }

    // Cursor: receivedAt + id descending. We take limit+1 to detect "more".
    if (q.cursor) {
      const cursorRow = await this.prisma.client.mailMessage.findUnique({
        where: { id: q.cursor },
        select: { receivedAt: true, id: true },
      });
      if (cursorRow) {
        // "Older" = strictly past the cursor: an earlier receivedAt, or the
        // same receivedAt with a lexicographically smaller id (stable
        // tiebreak). The cursor predicate goes into `where.AND` so it composes
        // with the search filter via top-level AND.
        //
        // IMPORTANT: do NOT assign `where.OR` here. When no search is active
        // `where.OR` is undefined, and setting it to `[]` makes Prisma treat
        // the whole query as "match nothing" - which returned an empty next
        // page every time you clicked "Older" without a search.
        Object.assign(where, {
          AND: [
            ...((where.AND as Prisma.MailMessageWhereInput[] | undefined) ?? []),
            {
              OR: [
                { receivedAt: { lt: cursorRow.receivedAt } },
                {
                  receivedAt: cursorRow.receivedAt,
                  id: { lt: cursorRow.id },
                },
              ],
            },
          ],
        });
      }
    }

    const rows = await this.prisma.client.mailMessage.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      select: {
        id: true,
        accountId: true,
        folderId: true,
        subject: true,
        fromAddress: true,
        fromName: true,
        bodyTextPreview: true,
        hasAttachments: true,
        isUnread: true,
        isStarred: true,
        receivedAt: true,
      },
    });

    const hasMore = rows.length > q.limit;
    const slice = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    return { items: slice, nextCursor };
  }

  async getMessage(userId: string, messageId: string): Promise<MailMessage> {
    const row = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { attachments: true, account: { select: { userId: true } } },
    });
    if (!row) throw new NotFoundException({ title: 'Message not found', status: 404 });
    if (row.account.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }

    // Sanitize HTML at read time, not at sync time. Sync-time sanitization
    // would lock us into whatever rule set was active when the message
    // landed; doing it on the read path lets us tighten policy and have it
    // apply to history immediately.
    const bodyHtml = sanitizeMailHtml(row.bodyHtml);

    return {
      id: row.id,
      accountId: row.accountId,
      folderId: row.folderId,
      subject: row.subject,
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      bodyTextPreview: row.bodyTextPreview,
      hasAttachments: row.hasAttachments,
      isUnread: row.isUnread,
      isStarred: row.isStarred,
      receivedAt: row.receivedAt,
      toAddresses: (row.toAddresses as string[] | null) ?? [],
      ccAddresses: (row.ccAddresses as string[] | null) ?? [],
      bccAddresses: (row.bccAddresses as string[] | null) ?? [],
      replyTo: row.replyTo,
      bodyText: row.bodyText,
      bodyHtml,
      messageId: row.messageId,
      inReplyTo: row.inReplyTo,
      references: (row.references as string[] | null) ?? null,
      flags: (row.flags as string[] | null) ?? [],
      sizeBytes: row.sizeBytes,
      sentAt: row.sentAt,
      attachments: row.attachments.map((a) => ({
        id: a.id,
        messageId: a.messageId,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        isInline: a.isInline,
        contentId: a.contentId,
      })),
    };
  }

  /**
   * Move a message to a destination folder by id or by role. Role-based
   * targeting (e.g. "archive", "trash", "spam") keeps the client UI simple -
   * it doesn't need to know the folder cuid.
   */
  async moveMessage(
    userId: string,
    messageId: string,
    target: { folderId?: string; role?: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX' },
  ): Promise<{ ok: true }> {
    const row = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { account: { select: { userId: true } } },
    });
    if (!row) throw new NotFoundException({ title: 'Message not found', status: 404 });
    if (row.account.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    let destinationId = target.folderId ?? null;
    if (!destinationId && target.role) {
      const folder = await this.prisma.client.mailFolder.findFirst({
        where: { accountId: row.accountId, role: target.role },
        orderBy: { position: 'asc' },
      });
      if (!folder) {
        throw new NotFoundException({
          title: 'Destination folder not found',
          status: 404,
          detail: `No folder with role ${target.role} on this account.`,
        });
      }
      destinationId = folder.id;
    }
    if (!destinationId) {
      throw new NotFoundException({
        title: 'Missing destination',
        status: 400,
        detail: 'Provide folderId or role.',
      });
    }
    await this.sync.moveMessage(messageId, destinationId);
    return { ok: true };
  }

  /**
   * Bulk move many messages at once. We pre-filter `ids` to only those the
   * caller owns; foreign / unknown ids are silently dropped (counted as
   * "skipped" by the underlying IMAP helper). This keeps the multi-select
   * UI's optimistic update honest without leaking the existence of a row
   * the user isn't allowed to see.
   */
  async bulkMoveMessages(
    userId: string,
    ids: string[],
    target: { folderId?: string; role?: 'ARCHIVE' | 'TRASH' | 'SPAM' | 'INBOX' },
  ): Promise<{ ok: true; affected: number; skipped: number }> {
    if (!target.folderId && !target.role) {
      throw new NotFoundException({
        title: 'Missing destination',
        status: 400,
        detail: 'Provide folderId or role.',
      });
    }
    const ownedIds = await this.filterOwnedMessageIds(userId, ids);
    const result = await this.sync.bulkMoveMessages(ownedIds, target);
    return {
      ok: true,
      affected: result.moved,
      skipped: result.skipped + (ids.length - ownedIds.length),
    };
  }

  /** Bulk \\Deleted + EXPUNGE for many messages. Restricted to Trash/Spam
   *  source folders so the UI can't accidentally nuke real mail. */
  async bulkDeleteMessages(
    userId: string,
    ids: string[],
  ): Promise<{ ok: true; affected: number; skipped: number }> {
    const ownedIds = await this.filterOwnedMessageIds(userId, ids);
    // Restrict to Trash / Spam - permanent delete from any other folder is
    // a foot-gun and the UI never offers it. Enforce here so a hand-rolled
    // client can't bypass that constraint.
    const safeRows = await this.prisma.client.mailMessage.findMany({
      where: {
        id: { in: ownedIds },
        folder: { role: { in: ['TRASH', 'SPAM'] } },
      },
      select: { id: true },
    });
    const safeIds = safeRows.map((r) => r.id);
    const result = await this.sync.bulkDeleteMessages(safeIds);
    return {
      ok: true,
      affected: result.deleted,
      skipped:
        result.skipped + (ids.length - safeIds.length),
    };
  }

  /** Bulk flag mutation across many messages. Same authorization model as
   *  bulkMoveMessages - foreign ids are silently dropped. */
  async bulkSetFlag(
    userId: string,
    ids: string[],
    op: 'read' | 'unread' | 'star' | 'unstar',
  ): Promise<{ ok: true; affected: number; skipped: number }> {
    const ownedIds = await this.filterOwnedMessageIds(userId, ids);
    const result = await this.sync.bulkSetFlag(ownedIds, op);
    return {
      ok: true,
      affected: result.updated,
      skipped: result.skipped + (ids.length - ownedIds.length),
    };
  }

  /**
   * Return the subset of `ids` that belong to MailAccounts owned by `userId`.
   * One query, no per-id round-trip. Used by every bulk endpoint as the
   * authorization gate.
   */
  private async filterOwnedMessageIds(
    userId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.client.mailMessage.findMany({
      where: { id: { in: ids }, account: { userId } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async setFlag(
    userId: string,
    messageId: string,
    op: 'read' | 'unread' | 'star' | 'unstar',
  ): Promise<{ ok: true }> {
    const row = await this.prisma.client.mailMessage.findUnique({
      where: { id: messageId },
      include: { account: { select: { userId: true } } },
    });
    if (!row) throw new NotFoundException({ title: 'Message not found', status: 404 });
    if (row.account.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }

    if (op === 'read' || op === 'unread') {
      await this.sync.setSeen(messageId, op === 'read');
      // Contextual auto-read: opening/reading the message clears its bell
      // notification. Best-effort - never fail the flag write over this.
      if (op === 'read') {
        void this.notifications
          .markReadByEntity(userId, 'mail', messageId)
          .catch(() => {});
      }
    } else {
      await this.sync.setFlagged(messageId, op === 'star');
    }
    return { ok: true };
  }

  /**
   * Implicit, debounced background sync invoked on every messages list call.
   * If the account has been synced in the last 30 s we skip; otherwise we
   * fire off a forward-only sync that pulls new mail without blocking the
   * HTTP response. Errors are logged but never propagate to the client.
   *
   * In-flight calls are tracked in-process so concurrent list requests
   * don't open redundant IMAP connections.
   */
  // Tight enough that interactive clicks feel snappy; loose enough that a
  // user mashing the message list doesn't open a new IMAP connection on
  // every render. With the 60 s frontend poll on the messages list, the
  // worst-case latency for a newly-arrived message is ~120 s and the average
  // is ~60 s.
  //
  // Bumped from 15 s → 60 s after HosterPK flagged our login rate as the
  // trigger for cPHulk/CSF auto-bans of the server IP. The IMAP IDLE watcher
  // is the real-time delivery path; this cooldown is the fallback poll, so
  // a generous interval is fine. The pooled IMAP connection in
  // ImapSyncService means rapid-fire syncs inside a single 4-minute window
  // share one TCP login regardless of this value.
  private static readonly SYNC_COOLDOWN_MS = 60_000;
  private readonly inflight = new Set<string>();
  private async maybeBackgroundSync(
    accountId: string,
    folderId: string | null,
  ): Promise<void> {
    if (this.inflight.has(accountId)) return;
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
      select: { status: true, lastSyncedAt: true, deletedAt: true },
    });
    if (!account || account.deletedAt) return;
    if (account.status !== 'ACTIVE') return;
    if (
      account.lastSyncedAt &&
      Date.now() - account.lastSyncedAt.getTime() < MailReadService.SYNC_COOLDOWN_MS
    ) {
      return;
    }
    this.inflight.add(accountId);
    try {
      // Always sync INBOX (new arrivals). Additionally sync the folder the
      // user is currently looking at, when it's not INBOX - otherwise that
      // folder's local state would drift indefinitely. Cheap because both
      // calls share the same account-level lastSyncedAt cooldown.
      await this.sync.syncAccount(accountId);
      if (folderId) {
        const folder = await this.prisma.client.mailFolder.findUnique({
          where: { id: folderId },
          select: { id: true, accountId: true, role: true },
        });
        if (folder && folder.accountId === accountId && folder.role !== 'INBOX') {
          await this.sync.syncFolderMessages(accountId, folder.id).catch((err) => {
            this.logThrottled(
              `bg-folder:${folder.id}`,
              'warn',
              `Per-folder background sync failed folderId=${folder.id} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          });
        }
      }
    } finally {
      this.inflight.delete(accountId);
    }
  }

  /**
   * Rewind a folder's `uidNext` cursor to 0 and re-run a full forward sync
   * against it. Used to repair folders whose stored MailMessage rows were
   * created with broken metadata (e.g. sent mail before the attachment
   * fix shipped). The sync's UPDATE branch heals attachment counts and
   * MailAttachment rows in place - read flags / starred / answered are
   * also refreshed, but no message content is destroyed.
   *
   * Expensive on large folders: every UID in the folder gets fetched
   * again. Intended as a one-shot recovery, not a routine call. So the
   * request only checks ownership and the rate cap, then queues a
   * `resync-folder` job on the `mail-resync` queue and answers 202;
   * `runFolderResync` does the work in the background process.
   */
  async resyncFolder(userId: string, folderId: string): Promise<MailFolderResyncQueued> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      include: { account: { select: { userId: true, id: true } } },
    });
    if (!folder) {
      throw new NotFoundException({ title: 'Folder not found', status: 404 });
    }
    if (folder.account.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }
    // The resync refetches every UID of the folder, so it is capped: one per
    // user per folder per window. SET NX EX claims the slot
    // atomically and always carries its expiry (an INCR whose EXPIRE never
    // ran would lock the folder for good). The slot is kept on failure too,
    // so a broken IMAP server is not hammered by retries.
    // Without Redis the cap cannot be checked (and the job could not be
    // queued), so refuse rather than run an uncapped full sync.
    // The client queues commands while Redis is down (no retry limit), so the
    // claim is bounded by a timeout instead of waiting for an error.
    const key = `mail:resync:${userId}:${folderId}`;
    let claimed: string | null;
    let claim: Promise<string | null> | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      claim = this.redis.client.set(key, '1', 'EX', MailReadService.RESYNC_WINDOW_SECONDS, 'NX');
      claimed = await Promise.race([
        claim,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis did not answer')),
            MailReadService.RESYNC_REDIS_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      // A slow Redis may still apply the queued claim after we gave up. Nothing
      // ran, so release it, or the person's retry would get a false 429.
      // Two edge cases are accepted:
      //  - a reply delayed past the 120 s expiry could DEL a newer claim for
      //    the same folder. One API instance today; if we scale out, a random
      //    token plus a compare-and-delete Lua script closes it;
      //  - a retry racing a timed-out claim can still get one false 429 until
      //    the late DEL lands.
      if (claim) {
        void claim
          .then((result) => (result === 'OK' ? this.redis.client.del(key) : undefined))
          .catch(() => undefined);
      }
      throw new ServiceUnavailableException({
        title: "Couldn't resync right now",
        status: 503,
        detail: 'Folder resync is temporarily unavailable. Try again in a few minutes.',
        code: 'mail_resync_unavailable',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (claimed !== 'OK') {
      throw new HttpException(
        {
          title: "Couldn't resync yet",
          status: 429,
          detail: 'This folder was resynced in the last 2 minutes. Try again in a minute.',
          code: 'mail_resync_rate_limited',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const jobId = mailResyncJobId(folderId);
    try {
      await this.queue.add(
        'resync-folder',
        { kind: 'resync-folder', accountId: folder.account.id, folderId },
        { ...MAIL_RESYNC_JOB_OPTIONS, jobId },
      );
    } catch (err) {
      // Nothing was queued: free the slot so the retry is not a false 429.
      void Promise.resolve()
        .then(() => this.redis.client.del(key))
        .catch(() => undefined);
      this.logger.warn(
        `Folder resync enqueue failed folderId=${folderId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      throw new ServiceUnavailableException({
        title: "Couldn't resync right now",
        status: 503,
        detail: 'Folder resync is temporarily unavailable. Try again in a few minutes.',
        code: 'mail_resync_unavailable',
      });
    }
    this.logger.log(`Folder resync queued folderId=${folderId}`);
    // `healed: 0` keeps clients from the previous release parsing the reply.
    return { ok: true, queued: true, jobId, healed: 0 };
  }

  /** Job body of `resync-folder` (MailResyncProcessor): rewind the cursor, re-sync. */
  async runFolderResync(accountId: string, folderId: string): Promise<void> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      select: { accountId: true },
    });
    if (!folder || folder.accountId !== accountId) {
      this.logger.warn(`Folder resync skipped: folder ${folderId} is gone.`);
      return;
    }
    await this.prisma.client.mailFolder.update({
      where: { id: folderId },
      data: { uidNext: BigInt(0) },
    });
    const result = await this.sync.syncFolderMessages(accountId, folderId);
    this.logger.log(
      `Folder resync done folderId=${folderId} inserted=${result.inserted} updated=${result.updated}`,
    );
  }

  async triggerSync(
    userId: string,
    accountId: string,
  ): Promise<{ ok: boolean; folders: number; messages: number; error?: string }> {
    await this.assertAccountOwner(userId, accountId);

    // Debounce mashed refresh clicks: at most one real IMAP fetch every 5 s
    // per account. Within the window we return immediately with zero deltas
    // - the client just refetches the (unchanged) DB rows, so spamming the
    // button while waiting on a slow OTP is cheap and never re-logs in.
    const now = Date.now();
    if (
      now - (this.lastManualSyncAt.get(accountId) ?? 0) <
      MailReadService.MANUAL_SYNC_COOLDOWN_MS
    ) {
      return { ok: true, folders: 0, messages: 0 };
    }
    this.lastManualSyncAt.set(accountId, now);

    // Await the sync so the response carries the real outcome. With INITIAL
    // sync limit at 200 messages this should complete within a few seconds;
    // larger inboxes still finish before the HTTP timeout. If we ever raise
    // the cap, move this onto a BullMQ job and have the client poll.
    try {
      const folderResult = await this.sync.syncFolders(accountId);
      let messages = 0;
      if (folderResult.inboxId) {
        const r = await this.sync.syncFolderMessages(accountId, folderResult.inboxId);
        messages = r.inserted + r.updated;
      }
      // Success is silent on purpose - the refresh button is pressed often
      // and a per-click info line would drown the log. Kept at debug for
      // when someone is actively tracing a sync.
      this.logger.debug(
        `Manual sync ok accountId=${accountId} folders=${folderResult.totalFolders} messages=${messages}`,
      );
      return { ok: true, folders: folderResult.totalFolders, messages };
    } catch (err) {
      const message = (err as Error)?.message ?? 'Sync failed';
      this.logThrottled(
        `manual-sync:${accountId}`,
        'error',
        `Manual sync FAILED accountId=${accountId} message=${message}`,
      );
      return { ok: false, folders: 0, messages: 0, error: message };
    }
  }

  async markFolderAllRead(
    userId: string,
    folderId: string,
  ): Promise<{ ok: true; updated: number }> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      select: { accountId: true },
    });
    if (!folder) throw new NotFoundException({ title: 'Folder not found', status: 404 });
    await this.assertAccountOwner(userId, folder.accountId);
    const updated = await this.sync.markFolderAllRead(folderId);
    return { ok: true, updated };
  }

  /**
   * Empty Trash or Spam. The caller must own the folder's account, and the
   * folder role must be TRASH or SPAM - emptying Inbox/Sent through this
   * endpoint would be a foot-gun.
   */
  async emptyFolder(
    userId: string,
    folderId: string,
  ): Promise<{ ok: true; deleted: number }> {
    const folder = await this.prisma.client.mailFolder.findUnique({
      where: { id: folderId },
      select: { accountId: true, role: true },
    });
    if (!folder) throw new NotFoundException({ title: 'Folder not found', status: 404 });
    await this.assertAccountOwner(userId, folder.accountId);
    if (folder.role !== 'TRASH' && folder.role !== 'SPAM') {
      throw new ForbiddenException({
        title: 'Only Trash and Spam folders can be emptied',
        status: 403,
      });
    }
    const deleted = await this.sync.emptyFolder(folderId);
    return { ok: true, deleted };
  }

  /**
   * Addresses the user has previously *sent* to, for compose autocomplete.
   * Derived from the account's Sent folder: scan a bounded window of recent
   * sent mail, flatten to/cc/bcc, dedupe case-insensitively, and rank by how
   * often each address appears (most-used first). Optional `q` filters by
   * case-insensitive substring so the field can narrow as the user types.
   */
  async recipientSuggestions(
    userId: string,
    query: RecipientSuggestionsQuery,
  ): Promise<{ items: string[] }> {
    await this.assertAccountOwner(userId, query.accountId);
    const sent = await this.prisma.client.mailFolder.findFirst({
      where: { accountId: query.accountId, role: 'SENT' },
      select: { id: true },
    });
    if (!sent) return { items: [] };

    // Bound the scan so a large Sent folder doesn't turn each keystroke into
    // a full-table read; recent sends are the relevant ones anyway.
    const rows = await this.prisma.client.mailMessage.findMany({
      where: { folderId: sent.id },
      orderBy: [{ sentAt: 'desc' }, { receivedAt: 'desc' }],
      take: MailReadService.SUGGESTION_SCAN_LIMIT,
      select: { toAddresses: true, ccAddresses: true, bccAddresses: true },
    });

    const q = query.q?.trim().toLowerCase() ?? '';
    // lowercased address -> { display, count }
    const tally = new Map<string, { display: string; count: number }>();
    for (const row of rows) {
      const all = [
        ...((row.toAddresses as string[] | null) ?? []),
        ...((row.ccAddresses as string[] | null) ?? []),
        ...((row.bccAddresses as string[] | null) ?? []),
      ];
      for (const raw of all) {
        const display = typeof raw === 'string' ? raw.trim() : '';
        if (!display) continue;
        const key = display.toLowerCase();
        if (q && !key.includes(q)) continue;
        const entry = tally.get(key);
        if (entry) entry.count++;
        else tally.set(key, { display, count: 1 });
      }
    }

    const items = [...tally.values()]
      .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
      .slice(0, query.limit)
      .map((e) => e.display);
    return { items };
  }

  private async assertAccountOwner(userId: string, accountId: string) {
    const acct = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
      select: { userId: true, deletedAt: true },
    });
    if (!acct || acct.deletedAt) {
      throw new NotFoundException({ title: 'Mail account not found', status: 404 });
    }
    if (acct.userId !== userId) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not own this mail account.',
      });
    }
  }
}
