import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@botss/database';
import type { Queue } from 'bullmq';
import type {
  SaveMailDraftInput,
  SaveMailDraftResult,
  SendMailMessageInput,
} from '@botss/shared-types';

import { createTransport } from 'nodemailer';

import { ImapSyncService } from './imap-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailCryptoService } from './mail-crypto.service';
import { resolvePublicHost } from './mail-ssrf';
import { MAIL_SEND_JOB_OPTIONS, MAIL_SEND_QUEUE, type MailJobData } from './mail.queue';

interface ResolvedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  /** FK back to the FileObject we pulled bytes from. Draft rows record
   *  this so the download endpoint can stream bytes from object storage
   *  directly without re-fetching the unsent draft from IMAP. */
  fileObjectId: string;
}

/**
 * Outbound mail. Persists every send as a `MailOutbox` row first (durable
 * across restarts), then enqueues a BullMQ job that performs the SMTP send
 * via the account's stored credentials. Attachments are out of scope in this
 * slice; attempting to set `attachmentFileObjectIds` is accepted by the
 * schema but ignored by the worker until Slice 3 wires file streaming.
 */
@Injectable()
export class MailSendService {
  private readonly logger = new Logger(MailSendService.name);
  private readonly s3: S3Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailCryptoService,
    private readonly sync: ImapSyncService,
    @InjectQueue(MAIL_SEND_QUEUE) private readonly queue: Queue<MailJobData>,
  ) {
    // Same config as FilesService - kept local so MailModule doesn't need to
    // depend on FilesModule for one download op.
    this.s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9100',
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'botss-local',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'botss-local-secret',
      },
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') !== 'false',
    });
  }

  /**
   * Resolve FileObject ids to bytes ready for MailComposer. Filters by the
   * uploader id (the same user composing the mail) rather than workspace -
   * mail accounts are user-scoped, and the user may be composing from a
   * different workspace than the one they uploaded the file in. The earlier
   * workspace filter dropped every attachment in that case, which is what
   * the user hit ("uploading but not sent").
   */
  /**
   * Read bytes for a single FileObject directly from object storage. Used
   * by the attachment download endpoint when a MailAttachment row has a
   * linked FileObject - typically draft mail (where the IMAP draft may
   * not yet exist or be unreliable) and the future-sent path. Bypasses
   * the IMAP fetch entirely so downloads stay fast and work even when
   * the IMAP server is briefly unavailable.
   */
  async fetchFileObjectBytes(
    fileObjectId: string,
  ): Promise<{ content: Buffer; filename: string; contentType: string } | null> {
    const row = await this.prisma.client.fileObject.findUnique({
      where: { id: fileObjectId },
    });
    if (!row) return null;
    try {
      const obj = await this.s3.send(
        new GetObjectCommand({ Bucket: row.bucket, Key: row.objectKey }),
      );
      const stream = obj.Body as NodeJS.ReadableStream | undefined;
      if (!stream) return null;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return {
        content: Buffer.concat(chunks),
        filename: row.filename,
        contentType: row.mimeType || 'application/octet-stream',
      };
    } catch (err) {
      this.logger.warn(
        `FileObject fetch failed fileObjectId=${fileObjectId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      return null;
    }
  }

  private async resolveAttachments(
    fileObjectIds: string[],
    uploaderId: string,
  ): Promise<ResolvedAttachment[]> {
    if (fileObjectIds.length === 0) return [];
    const rows = await this.prisma.client.fileObject.findMany({
      where: { id: { in: fileObjectIds }, uploadedById: uploaderId },
    });
    const resolved: ResolvedAttachment[] = [];
    for (const f of rows) {
      try {
        const obj = await this.s3.send(
          new GetObjectCommand({ Bucket: f.bucket, Key: f.objectKey }),
        );
        const stream = obj.Body as NodeJS.ReadableStream | undefined;
        if (!stream) continue;
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        resolved.push({
          filename: f.filename,
          contentType: f.mimeType || 'application/octet-stream',
          content: Buffer.concat(chunks),
          fileObjectId: f.id,
        });
      } catch (err) {
        this.logger.warn(
          `Attachment fetch failed fileObjectId=${f.id} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    return resolved;
  }

  /**
   * Copy a freshly-sent message to the IMAP Sent folder. cPanel/Exim does
   * not auto-copy outbound SMTP submissions to Sent - we do it ourselves
   * so the message is visible across every IMAP client. Best-effort; the
   * SMTP send is the source of truth for delivery, this is for visibility.
   *
   * Triggers a Sent-folder re-sync so the new row appears in the CRM list
   * without waiting for the 60-second poll tick.
   */
  private async appendToSent(accountId: string, raw: Buffer): Promise<void> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) return;

    let sentFolder = await this.prisma.client.mailFolder.findFirst({
      where: { accountId, role: 'SENT' },
      orderBy: { position: 'asc' },
    });
    if (!sentFolder) {
      // Folder list hasn't been synced yet. Sync folders first, then retry.
      await this.sync.syncFolders(accountId);
      sentFolder = await this.prisma.client.mailFolder.findFirst({
        where: { accountId, role: 'SENT' },
      });
      if (!sentFolder) {
        this.logger.warn(`No Sent folder discovered for accountId=${accountId}; skipping APPEND.`);
        return;
      }
    }

    // APPEND on the server AND, in the same connection, capture the UID
    // assigned (UIDPLUS extension) so we can insert the MailMessage row
    // directly. This is the "Sent messages should appear in CRM" path -
    // we never backfill historical Sent mail, but every send we issue
    // lands as a row in the local DB.
    // Shared pooled connection: a fresh login per send was one of the login
    // bursts that got the server IP throttled by the mail host.
    await this.sync.withClient(account, async (imap) => {
      // APPEND first. UIDPLUS-capable servers return the assigned UID in the
      // response; cPanel/Courier often doesn't, so we capture it and fall
      // back to re-fetching the most-recent message in Sent below.
      const appendResult = await imap.append(sentFolder.path, raw, ['\\Seen']);
      let appendedUid: number | null =
        appendResult && typeof appendResult === 'object' && 'uid' in appendResult
          ? (appendResult as { uid?: number }).uid ?? null
          : null;

      // Fallback: open the Sent folder and grab the latest sequence number.
      // The just-appended message is always the highest, so `*` returns it.
      // This is the path cPanel/Courier takes.
      if (appendedUid == null) {
        const lock = await imap.getMailboxLock(sentFolder.path);
        try {
          const fetched = (await imap.fetchOne('*', { uid: true })) as unknown;
          if (fetched && typeof fetched === 'object' && 'uid' in fetched) {
            const u = (fetched as { uid?: number }).uid;
            if (typeof u === 'number') appendedUid = u;
          }
        } finally {
          lock.release();
        }
      }

      if (appendedUid == null) {
        this.logger.warn(
          `Could not determine UID after APPEND accountId=${accountId} sentPath=${sentFolder.path}. Sent row will be missing until the next sync picks it up.`,
        );
        return;
      }

      // Insert the row directly from the raw bytes we already have.
      const { simpleParser } = await import('mailparser');
      const parsed = await simpleParser(raw);
      const subject = parsed.subject ?? '';
      const fromHdr = Array.isArray(parsed.from) ? parsed.from[0] : parsed.from;
      const fromAddress = fromHdr?.value?.[0]?.address ?? account.email;
      const fromName = fromHdr?.value?.[0]?.name ?? account.displayName;
      const toArr = arrify(parsed.to).flatMap((a) =>
        (a?.value ?? []).map((v) => v.address ?? '').filter(Boolean),
      );
      const ccArr = arrify(parsed.cc).flatMap((a) =>
        (a?.value ?? []).map((v) => v.address ?? '').filter(Boolean),
      );
      const bccArr = arrify(parsed.bcc).flatMap((a) =>
        (a?.value ?? []).map((v) => v.address ?? '').filter(Boolean),
      );
      const messageId = parsed.messageId ?? null;
      const bodyText = (parsed.text ?? '').slice(0, 1_000_000);
      const bodyTextPreview = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
      const bodyHtml = typeof parsed.html === 'string' ? parsed.html.slice(0, 2_000_000) : null;

      // mailparser surfaces every attachment in the message's MIME tree -
      // both real attachments and `cid:`-referenced inline images. We
      // record both so the reader (which filters out inline ones in the
      // attachment-strip but still serves them by id for the body iframe)
      // sees the same shape it would for an INBOX message synced via
      // imap-sync.
      const parsedAttachments = parsed.attachments ?? [];
      const hasAttachments = parsedAttachments.length > 0;

      // Wrap the message row + attachment rows in one transaction so a
      // failure halfway through doesn't leave a `hasAttachments: true`
      // message with zero MailAttachment rows. If the whole transaction
      // throws, `uidNext` stays where it was and the next forward-only
      // sync re-fetches via imap-sync.service.ts (which has its own
      // attachment-parsing path).
      this.logger.log(
        `Sent APPEND parsed: accountId=${accountId} uid=${appendedUid} attachmentCount=${parsedAttachments.length}`,
      );
      await this.prisma.client.$transaction(async (tx) => {
        const upserted = await tx.mailMessage.upsert({
          where: {
            accountId_folderId_uid: {
              accountId,
              folderId: sentFolder.id,
              uid: BigInt(appendedUid),
            },
          },
          create: {
            accountId,
            folderId: sentFolder.id,
            uid: BigInt(appendedUid),
            messageId,
            subject,
            fromAddress,
            fromName: fromName ?? null,
            toAddresses: toArr as unknown as Prisma.InputJsonValue,
            ccAddresses: ccArr as unknown as Prisma.InputJsonValue,
            bccAddresses: bccArr as unknown as Prisma.InputJsonValue,
            replyTo: null,
            bodyTextPreview,
            bodyText,
            bodyHtml,
            hasAttachments,
            attachmentCount: parsedAttachments.length,
            sizeBytes: raw.length,
            receivedAt: new Date(),
            sentAt: new Date(),
            flags: ['\\Seen'] as unknown as Prisma.InputJsonValue,
            isUnread: false,
            isStarred: false,
            isAnswered: false,
            references: Prisma.JsonNull,
          },
          // The upsert UPDATE branch is hit when this is a retry against an
          // already-inserted message - patch the attachment counters and
          // clear any stale MailAttachment rows so the createMany below
          // can re-insert from the raw bytes cleanly.
          update: {
            hasAttachments,
            attachmentCount: parsedAttachments.length,
          },
          select: { id: true },
        });

        if (hasAttachments) {
          // Drop any pre-existing attachment rows (retry / replayed APPEND)
          // before re-inserting so we don't accumulate duplicates.
          await tx.mailAttachment.deleteMany({
            where: { messageId: upserted.id },
          });
          // mailparser exposes the MIME `partId` on each attachment as a
          // dot-separated path (e.g. "2", "2.1") at runtime; it's not on
          // its public TS type. Cast through `unknown` to read it without
          // tripping strict tsc. Fall back to a sequential id mirroring the
          // MIME part numbering when absent.
          await tx.mailAttachment.createMany({
            data: parsedAttachments.map((a, idx) => {
              const partIdRaw = (a as unknown as { partId?: string }).partId;
              const partId =
                typeof partIdRaw === 'string' && partIdRaw.length > 0
                  ? partIdRaw
                  : String(idx + 1);
              return {
                messageId: upserted.id,
                partId,
                filename: a.filename ?? `attachment-${idx + 1}`,
                contentType: a.contentType ?? 'application/octet-stream',
                sizeBytes: typeof a.size === 'number' ? a.size : 0,
                isInline: a.contentDisposition === 'inline',
                contentId: typeof a.contentId === 'string' ? a.contentId : null,
              };
            }),
          });
        }
      });

      // Advance the folder cursor past our just-appended message so a
      // subsequent forward-only sync doesn't try to re-fetch it. Done
      // OUTSIDE the transaction so a failure inside leaves uidNext alone
      // and the next sync recovers via the IMAP sync path.
      await this.prisma.client.mailFolder.update({
        where: { id: sentFolder.id },
        data: { uidNext: BigInt(appendedUid + 1) },
      });
    });
  }

  /** Force a one-shot INBOX sync after a self-addressed send. Walks the
   *  same forward-only path the background poller uses; if no new UIDs
   *  exist the call is essentially free. */
  private async syncInboxAfterSelfSend(accountId: string): Promise<void> {
    const inbox = await this.prisma.client.mailFolder.findFirst({
      where: { accountId, role: 'INBOX' },
      orderBy: { position: 'asc' },
    });
    if (!inbox) return;
    // cPanel's local delivery (SMTP -> Maildir/INBOX) is asynchronous; the
    // message typically lands 1-5s after SMTP returns. A single immediate
    // sync almost always misses it, then the 15s background-sync cooldown
    // blocks the next attempt. Poll a few times with backoff so the user
    // sees their self-addressed mail within a few seconds.
    const delays = [2_000, 5_000, 10_000, 20_000];
    let attempt = 0;
    for (const delay of delays) {
      attempt++;
      await new Promise((r) => setTimeout(r, delay));
      try {
        const result = await this.sync.syncFolderMessages(accountId, inbox.id);
        if (result.inserted > 0) {
          this.logger.log(
            `Self-send INBOX sync hit attempt=${attempt} inserted=${result.inserted}`,
          );
          return;
        }
      } catch (err) {
        this.logger.warn(
          `INBOX self-send retry sync failed attempt=${attempt} accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }
    this.logger.warn(
      `Self-send INBOX did not see new mail after 4 retries accountId=${accountId}. Background poll will pick it up if it arrives later.`,
    );
  }

  /**
   * Save a draft to the IMAP DRAFTS folder. Builds the raw RFC822 once,
   * APPENDs with the `\Draft \Seen` flags, captures the assigned UID via
   * UIDPLUS or (cPanel fallback) by re-fetching `*`, and inserts a
   * MailMessage row so the draft is immediately visible in the CRM
   * Drafts folder. If `replacesDraftId` is provided, the previous draft is
   * deleted from IMAP first.
   */
  async saveDraft(
    userId: string,
    input: SaveMailDraftInput,
  ): Promise<SaveMailDraftResult> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException({ title: 'Mail account not found', status: 404 });
    }
    if (account.userId !== userId) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not own this mail account.',
      });
    }

    let draftsFolder = await this.prisma.client.mailFolder.findFirst({
      where: { accountId: account.id, role: 'DRAFTS' },
      orderBy: { position: 'asc' },
    });
    if (!draftsFolder) {
      await this.sync.syncFolders(account.id);
      draftsFolder = await this.prisma.client.mailFolder.findFirst({
        where: { accountId: account.id, role: 'DRAFTS' },
      });
      if (!draftsFolder) {
        throw new NotFoundException({
          title: 'Drafts folder not found',
          status: 404,
          detail: 'No DRAFTS folder discovered on the IMAP server.',
        });
      }
    }

    const fromName = account.displayName;
    const fromEmail = account.email;
    const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
    const to = input.to ?? [];
    const cc = input.cc ?? [];
    const bcc = input.bcc ?? [];
    const subject = input.subject ?? '';
    const bodyText = input.bodyText ?? '';
    const bodyHtml = input.bodyHtml ?? null;

    // Resolve attachments to byte buffers the same way the send worker does
    // so the IMAP draft is byte-identical to what a future send would emit.
    // Without this, "Save Draft" silently drops uploaded files and the
    // user only notices when they reopen the draft and the chips are gone.
    const draftAttachmentIds = (input.attachmentFileObjectIds ?? []).filter(Boolean);
    const draftAttachments = await this.resolveAttachments(
      draftAttachmentIds,
      userId,
    );

    const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
    const composer = new MailComposer({
      from,
      to: to.length > 0 ? to.join(', ') : undefined,
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      bcc: bcc.length > 0 ? bcc.join(', ') : undefined,
      subject,
      text: bodyText,
      html: bodyHtml ?? `<p>${escapeHtml(bodyText)}</p>`,
      attachments: draftAttachments.length > 0
        ? draftAttachments.map((a) => ({
            filename: a.filename,
            content: a.content,
            contentType: a.contentType,
          }))
        : undefined,
    });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((err: Error | null, msg: Buffer) => {
        if (err) reject(err);
        else resolve(msg);
      });
    });

    // If we're replacing an existing draft, delete it from IMAP first so the
    // user doesn't see two copies. We do this in the same session as the
    // APPEND so a failure leaves either one or zero drafts, never duplicates
    // hanging around silently.
    let oldDraftUid: bigint | null = null;
    let oldDraftRowId: string | null = null;
    if (input.replacesDraftId) {
      const existing = await this.prisma.client.mailMessage.findUnique({
        where: { id: input.replacesDraftId },
        include: { folder: true, account: true },
      });
      if (existing && existing.account.userId === userId) {
        oldDraftUid = existing.uid;
        oldDraftRowId = existing.id;
      }
    }

    // Declared with a widened type: the assignment happens inside the pooled
    // client callback, which TypeScript's narrowing cannot see.
    let appendedUid = null as number | null;
    await this.sync.withClient(account, async (imap) => {
      const lock = await imap.getMailboxLock(draftsFolder.path);
      try {
        if (oldDraftUid != null) {
          try {
            await imap.messageFlagsAdd(oldDraftUid.toString(), ['\\Deleted'], {
              uid: true,
            });
            await imap.messageDelete(oldDraftUid.toString(), { uid: true });
          } catch (err) {
            this.logger.warn(
              `Failed to delete previous draft uid=${oldDraftUid} accountId=${account.id} message=${(err as Error)?.message ?? 'unknown'}`,
            );
          }
        }

        const appendResult = await imap.append(
          draftsFolder.path,
          raw,
          ['\\Draft', '\\Seen'],
        );
        appendedUid =
          appendResult && typeof appendResult === 'object' && 'uid' in appendResult
            ? (appendResult as { uid?: number }).uid ?? null
            : null;
        if (appendedUid == null) {
          const fetched = (await imap.fetchOne('*', { uid: true })) as unknown;
          if (fetched && typeof fetched === 'object' && 'uid' in fetched) {
            const u = (fetched as { uid?: number }).uid;
            if (typeof u === 'number') appendedUid = u;
          }
        }
      } finally {
        lock.release();
      }
    });

    if (appendedUid == null) {
      throw new NotFoundException({
        title: 'Draft saved on server but UID unknown',
        status: 500,
        detail:
          'The draft was appended to IMAP but the server did not return a UID. It will appear on the next sync.',
      });
    }
    const draftUid: number = appendedUid;

    // Local row insert mirrors the appendToSent flow so the draft is
    // immediately visible without waiting for a poll. The compose dialog
    // also reads the draft back from this row when the user reopens an
    // unsent message, so any mismatch between this row's attachment
    // metadata and the raw RFC822 surfaces as "saved attachments
    // disappear after Save Draft".
    const bodyTextPreview = bodyText.replace(/\s+/g, ' ').trim().slice(0, 200);
    const hasAttachments = draftAttachments.length > 0;

    const created = await this.prisma.client.$transaction(async (tx) => {
      const upserted = await tx.mailMessage.upsert({
        where: {
          accountId_folderId_uid: {
            accountId: account.id,
            folderId: draftsFolder.id,
            uid: BigInt(draftUid),
          },
        },
        create: {
          accountId: account.id,
          folderId: draftsFolder.id,
          uid: BigInt(draftUid),
          messageId: null,
          subject,
          fromAddress: fromEmail,
          fromName: fromName ?? null,
          toAddresses: to as unknown as Prisma.InputJsonValue,
          ccAddresses: cc as unknown as Prisma.InputJsonValue,
          bccAddresses: bcc as unknown as Prisma.InputJsonValue,
          replyTo: null,
          bodyTextPreview,
          bodyText,
          bodyHtml,
          hasAttachments,
          attachmentCount: draftAttachments.length,
          sizeBytes: raw.length,
          receivedAt: new Date(),
          sentAt: null,
          flags: ['\\Draft', '\\Seen'] as unknown as Prisma.InputJsonValue,
          isUnread: false,
          isStarred: false,
          isAnswered: false,
          inReplyTo: null,
          references: Prisma.JsonNull,
        },
        // Retry-safe: a replayed APPEND must heal counters AND attachment
        // rows so a half-failed prior attempt doesn't leak through.
        update: {
          hasAttachments,
          attachmentCount: draftAttachments.length,
        },
      });

      if (hasAttachments) {
        // Wipe any stale attachment rows from a prior partial write,
        // then re-insert. Each attachment is keyed off the resolved
        // FileObject so the download endpoint can stream bytes directly
        // from object storage instead of re-fetching from IMAP - same
        // shape we'd build if the message had been sent normally.
        await tx.mailAttachment.deleteMany({
          where: { messageId: upserted.id },
        });
        await tx.mailAttachment.createMany({
          data: draftAttachments.map((a, idx) => ({
            messageId: upserted.id,
            partId: String(idx + 1),
            filename: a.filename,
            contentType: a.contentType,
            sizeBytes: a.content.byteLength,
            isInline: false,
            contentId: null,
            fileObjectId: a.fileObjectId,
          })),
        });
      }
      return upserted;
    });

    if (oldDraftRowId && oldDraftRowId !== created.id) {
      await this.prisma.client.mailMessage
        .delete({ where: { id: oldDraftRowId } })
        .catch(() => {});
    }

    await this.prisma.client.mailFolder.update({
      where: { id: draftsFolder.id },
      data: { uidNext: BigInt(draftUid + 1) },
    });

    return { draftMessageId: created.id };
  }

  /** Remove a draft from both the local DB and the IMAP server. */
  async deleteDraft(userId: string, draftMessageId: string): Promise<void> {
    const row = await this.prisma.client.mailMessage.findUnique({
      where: { id: draftMessageId },
      include: { folder: true, account: true },
    });
    if (!row) return;
    if (row.account.userId !== userId) {
      throw new ForbiddenException({ title: 'Forbidden', status: 403 });
    }

    await this.sync.withClient(row.account, async (imap) => {
      const lock = await imap.getMailboxLock(row.folder.path);
      try {
        await imap.messageFlagsAdd(row.uid.toString(), ['\\Deleted'], { uid: true });
        await imap.messageDelete(row.uid.toString(), { uid: true });
      } finally {
        lock.release();
      }
    });
    await this.prisma.client.mailMessage
      .delete({ where: { id: draftMessageId } })
      .catch(() => {});
  }

  async enqueue(userId: string, input: SendMailMessageInput) {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: input.accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException({ title: 'Mail account not found', status: 404 });
    }
    if (account.userId !== userId) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not own this mail account.',
      });
    }
    if (account.status !== 'ACTIVE') {
      throw new ForbiddenException({
        title: 'Account not active',
        status: 403,
        detail:
          'This mailbox has not been verified. Test the connection in Mail accounts settings before sending.',
      });
    }

    if (input.inReplyToMessageId) {
      // The parent's Message-ID and References headers go into the outgoing
      // mail, so it must be a message in one of the sender's own mailboxes.
      const parent = await this.prisma.client.mailMessage.findFirst({
        where: { id: input.inReplyToMessageId, account: { userId } },
        select: { id: true },
      });
      if (!parent) {
        throw new BadRequestException({
          title: 'Invalid reply target',
          status: 400,
          detail: 'The message you are replying to was not found in your mailboxes.',
          code: 'invalid_reply_target',
        });
      }
    }

    const outbox = await this.prisma.client.mailOutbox.create({
      data: {
        accountId: account.id,
        userId,
        toAddresses: input.to as unknown as Prisma.InputJsonValue,
        ccAddresses: (input.cc ?? []) as unknown as Prisma.InputJsonValue,
        bccAddresses: (input.bcc ?? []) as unknown as Prisma.InputJsonValue,
        subject: input.subject,
        bodyText: input.bodyText,
        bodyHtml: input.bodyHtml ?? null,
        inReplyToMessageId: input.inReplyToMessageId ?? null,
        replacesDraftId: input.replacesDraftId ?? null,
        attachmentFileObjectIds:
          (input.attachmentFileObjectIds ?? []) as unknown as Prisma.InputJsonValue,
        status: 'QUEUED',
      },
    });

    await this.queue
      .add('send', { kind: 'send', outboxId: outbox.id }, MAIL_SEND_JOB_OPTIONS)
      .catch((err) => {
        this.logger.error(
          `Failed to enqueue mail send outboxId=${outbox.id} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      });

    return outbox;
  }

  /** Worker entry: actually deliver one outbox row. */
  async processSend(outboxId: string): Promise<void> {
    const row = await this.prisma.client.mailOutbox.findUnique({
      where: { id: outboxId },
      include: { account: true },
    });
    if (!row) {
      this.logger.warn(`Outbox row ${outboxId} not found.`);
      return;
    }
    if (row.status === 'SENT' || row.status === 'CANCELLED') return;

    await this.prisma.client.mailOutbox.update({
      where: { id: outboxId },
      data: { status: 'SENDING', attemptCount: { increment: 1 } },
    });

    try {
      const password = this.crypto.decrypt(row.account.passwordCiphertext);
      const fromName = row.account.displayName;
      const fromEmail = row.account.email;
      const from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;

      // In-Reply-To / References are wired here when we have a parent
      // MailMessage to thread against. Slice 2 ships threading; for now we
      // pass-through inReplyToMessageId from the request and the server side
      // looks up the Message-ID header if present.
      let inReplyTo: string | null = null;
      let references: string[] = [];
      if (row.inReplyToMessageId) {
        const parent = await this.prisma.client.mailMessage.findFirst({
          where: { id: row.inReplyToMessageId, account: { userId: row.userId } },
          select: { messageId: true, references: true },
        });
        if (parent?.messageId) {
          inReplyTo = parent.messageId;
          const parentRefs = Array.isArray(parent.references)
            ? (parent.references as string[])
            : [];
          references = [...parentRefs, parent.messageId];
        }
      }

      const to = (row.toAddresses as string[]) ?? [];
      const cc = (row.ccAddresses as string[]) ?? [];
      const bcc = (row.bccAddresses as string[]) ?? [];

      // Resolve attachments from FileObject ids to actual byte buffers. The
      // worker pulls bytes from S3/MinIO before MailComposer is built so the
      // raw RFC822 contains the parts inline and the IMAP APPEND copy carries
      // them too.
      const attachmentIds = ((row.attachmentFileObjectIds as string[]) ?? []).filter(
        Boolean,
      );
      const attachments = await this.resolveAttachments(
        attachmentIds,
        row.userId,
      );

      // Build the raw RFC822 bytes ONCE so SMTP send and IMAP APPEND operate
      // on identical content. Without this, the Sent-folder copy would have
      // a different Message-ID than what the recipient sees, breaking thread
      // reconciliation if the recipient replies.
      const { default: MailComposer } = await import('nodemailer/lib/mail-composer');
      const composer = new MailComposer({
        from,
        to: to.join(', '),
        cc: cc.length > 0 ? cc.join(', ') : undefined,
        bcc: bcc.length > 0 ? bcc.join(', ') : undefined,
        subject: row.subject,
        text: row.bodyText,
        html: row.bodyHtml ?? `<p>${escapeHtml(row.bodyText)}</p>`,
        inReplyTo: inReplyTo ?? undefined,
        references: references.length > 0 ? references : undefined,
        attachments: attachments.length > 0
          ? attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            }))
          : undefined,
      });
      const raw = await new Promise<Buffer>((resolve, reject) => {
        composer.compile().build((err: Error | null, msg: Buffer) => {
          if (err) reject(err);
          else resolve(msg);
        });
      });

      // Outbound transport: prefer a configured SMTP relay (Brevo / SMTP2GO /
      // SES-SMTP on an open port such as 587/2525) over the account's own
      // cPanel SMTP, which AWS port-throttling makes slow and unreliable. The
      // relay forwards our raw MIME verbatim, so the Message-ID, threading
      // headers (In-Reply-To / References) and attachments are preserved and
      // the IMAP Sent-folder copy still matches what the recipient sees. The
      // envelope/From stays the user's address (the relay must be authorized
      // to send for the domain via SPF/DKIM). With no relay configured this
      // falls back to the account SMTP, so existing setups are unchanged.
      const relay = resolveSmtpRelay();
      const smtp = relay ?? {
        host: row.account.smtpHost,
        port: row.account.smtpPort,
        secure: row.account.smtpSecure,
        user: row.account.username,
        pass: password,
      };
      // Connect to the vetted address; keep the name for TLS SNI and the
      // certificate check (DNS rebinding).
      const target = await resolvePublicHost(smtp.host);
      const transport = createTransport({
        host: target.host,
        ...(target.servername ? { tls: { servername: target.servername } } : {}),
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 30_000, // nodemailer 10: covers DNS + connect + greeting + STARTTLS
      });
      try {
        await transport.sendMail({
          raw,
          envelope: {
            from: fromEmail,
            to: [...to, ...cc, ...bcc],
          },
        });
      } finally {
        transport.close();
      }

      await this.prisma.client.mailOutbox.update({
        where: { id: outboxId },
        data: { status: 'SENT', sentAt: new Date(), lastError: null },
      });

      this.logger.log(
        `Mail sent outboxId=${outboxId} accountId=${row.accountId} to=${to.join(',')} subject=${JSON.stringify(row.subject)}`,
      );

      // Append the sent message to the IMAP Sent folder. cPanel / Exim does
      // not auto-copy outbound SMTP submissions; we copy it ourselves so the
      // message is visible across every IMAP client (CRM + webmail + phone).
      // Fire-and-forget - the SMTP send already succeeded, so an APPEND
      // failure is degraded but not fatal. The next sync picks the message
      // up from webmail's Sent folder anyway if APPEND fails.
      void this.appendToSent(row.accountId, raw).catch((err) => {
        this.logger.warn(
          `IMAP APPEND to Sent failed accountId=${row.accountId} outboxId=${outboxId} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      });

      // If any recipient is the sender's own address, the SMTP server will
      // also deliver the message locally to INBOX. Force an INBOX sync so
      // the user sees the message in both Inbox and Sent without waiting
      // for the next polling tick. No-op if it wasn't self-addressed -
      // the sync just confirms no new UIDs and returns.
      const selfAddressed = [...to, ...cc, ...bcc]
        .map((a) => a.toLowerCase().trim())
        .includes(row.account.email.toLowerCase());
      if (selfAddressed) {
        void this.syncInboxAfterSelfSend(row.accountId).catch((err) => {
          this.logger.warn(
            `INBOX re-sync after self-send failed accountId=${row.accountId} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        });
      }

      // Sent from a draft? Delete the IMAP draft now that the message is
      // delivered. Best-effort; the user can always discard manually.
      if (row.replacesDraftId) {
        void this.deleteDraft(row.userId, row.replacesDraftId).catch((err) => {
          this.logger.warn(
            `Failed to delete draft after send draftId=${row.replacesDraftId} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        });
      }
    } catch (err) {
      // nodemailer surfaces auth + connection errors via `code` and
      // `responseCode` on the thrown error. We treat 5xx + EAUTH as permanent
      // and everything else as transient (BullMQ retries with backoff).
      const e = err as { code?: string; responseCode?: number; message?: string };
      const permanent =
        e?.code === 'EAUTH' ||
        (typeof e?.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600);
      const message = e?.message ?? 'unknown';
      await this.prisma.client.mailOutbox.update({
        where: { id: outboxId },
        data: { status: 'FAILED', lastError: message },
      });
      this.logger.error(
        `Mail send failed outboxId=${outboxId} permanent=${permanent} code=${e?.code ?? 'unknown'} responseCode=${e?.responseCode ?? 'unknown'} message=${message}`,
      );
      if (permanent) {
        // Auth or other 5xx error - no point retrying with the same creds.
        return;
      }
      // Transient: rethrow so BullMQ retries with exponential backoff.
      throw err;
    }
  }
}

/**
 * Optional global SMTP relay. When `MAIL_RELAY_HOST` (plus user + password)
 * is configured, all outbound user mail is delivered through this relay
 * instead of each account's own, port-throttled cPanel SMTP - the fix for
 * "really slow sent". Point it at a reputable free relay on an open port:
 *   - Brevo:   smtp-relay.brevo.com:587   (300 emails/day free)
 *   - SMTP2GO: mail.smtp2go.com:2525      (1,000 emails/month free)
 *   - Amazon SES SMTP: email-smtp.<region>.amazonaws.com:587
 * The relay must be authorized to send for the sending domain (SPF + DKIM).
 * It transmits our raw MIME unchanged, so threading and the Sent-folder copy
 * are preserved. Returns null when unconfigured (account SMTP is used).
 */
function resolveSmtpRelay(): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
} | null {
  const host = process.env.MAIL_RELAY_HOST?.trim();
  const user = process.env.MAIL_RELAY_USER?.trim();
  const pass = process.env.MAIL_RELAY_PASSWORD || process.env.MAIL_RELAY_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number.parseInt(process.env.MAIL_RELAY_PORT ?? '587', 10),
    secure: (process.env.MAIL_RELAY_SECURE ?? 'false').toLowerCase() === 'true',
    user,
    pass,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br/>');
}

/** Normalize mailparser's AddressObject | AddressObject[] union into an array. */
function arrify<T>(v: T | T[] | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
