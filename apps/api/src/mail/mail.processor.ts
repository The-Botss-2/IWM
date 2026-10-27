import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import type { Job } from 'bullmq';

import { ImapIdleService } from './imap-idle.service';
import { ImapSyncService } from './imap-sync.service';
import { MailCryptoService } from './mail-crypto.service';
import { MAIL_QUEUE, type MailJobData } from './mail.queue';
import { MailReadService } from './mail-read.service';
import { MailSendService } from './mail-send.service';
import { MailVerifierService } from './mail-verifier.service';
import { isSplitRole, PROCESS_ROLE, type ProcessRole } from '../common/process-role';
import { PrismaService } from '../prisma/prisma.service';

/**
 * BullMQ worker for the mail queue. Handles every async mail job:
 *
 *   - `verify-account` → tests SMTP creds against the live server
 *   - `send` → drains MailOutbox via per-account SMTP
 *   - `initial-sync` → folder + recent-message fetch from IMAP
 *   - `resync-folder` → manual full re-sync of one folder (new jobs go to
 *     the `mail-resync` queue; kept here for jobs queued before the move)
 */
@Processor(MAIL_QUEUE)
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailCryptoService,
    private readonly verifier: MailVerifierService,
    private readonly sendService: MailSendService,
    private readonly sync: ImapSyncService,
    private readonly idle: ImapIdleService,
    private readonly read: MailReadService,
    @Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all',
  ) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    switch (job.data.kind) {
      case 'verify-account':
        await this.verifyAccount(job.data.accountId, job.attemptsMade);
        return;
      case 'send':
        // New sends go to MAIL_SEND_QUEUE. Kept so jobs already waiting on
        // this queue when the split deployed still go out.
        await this.sendService.processSend(job.data.outboxId);
        return;
      case 'initial-sync':
        await this.runInitialSync(job.data.accountId);
        return;
      case 'resync-folder':
        await this.read.runFolderResync(job.data.accountId, job.data.folderId);
        return;
    }
  }

  private async runInitialSync(accountId: string): Promise<void> {
    try {
      await this.sync.syncAccount(accountId);
      this.logger.log(`initial-sync completed accountId=${accountId}`);
    } catch (err) {
      this.logger.warn(
        `initial-sync failed accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      throw err;
    }
  }

  private async verifyAccount(accountId: string, attempt: number): Promise<void> {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) {
      this.logger.warn(`verify-account skipped: account ${accountId} not found or deleted.`);
      return;
    }

    const password = this.crypto.decrypt(account.passwordCiphertext);
    const result = await this.verifier.verify({
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure,
      username: account.username,
      password,
    });

    await this.prisma.client.mailAccount.update({
      where: { id: accountId },
      data: {
        status: result.status,
        lastError: result.error,
        lastSyncedAt: result.status === 'ACTIVE' ? new Date() : account.lastSyncedAt,
      },
    });

    this.logger.log(
      `verify-account accountId=${accountId} attempt=${attempt + 1} status=${result.status} imapOk=${result.imapOk} smtpOk=${result.smtpOk}`,
    );

    if (result.status === 'AUTH_FAILED') {
      // Permanent failure - no point retrying with the same (presumably
      // wrong) password. Return so the job is recorded as complete; the user
      // sees AUTH_FAILED in the UI.
      return;
    }
    if (result.status === 'CONNECTION_FAILED') {
      throw new Error(result.error ?? 'Mail server connection failed');
    }

    // With ROLE=api the credential change evicted the api's pooled IMAP
    // client, not this process's: drop ours too, or it keeps the old
    // password. (ROLE=all shares one pool, already evicted.)
    if (isSplitRole(this.role)) this.sync.evictPooledClient(accountId);

    // ACTIVE: kick off the initial sync inline. Run-and-forget so a slow
    // IMAP scrape doesn't extend the verify-account job's runtime.
    void this.sync.syncAccount(accountId).catch((err) => {
      this.logger.warn(
        `Initial sync after verify failed accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    });
    // Start an IDLE watcher so new mail arrives in real time. Fire-and-forget
    // - the watcher's own reconnect loop handles transient failures, and a
    // failure here must never block verify-account from completing. An
    // existing watcher may be sleeping off the old password's backoff, so
    // replace it rather than wait for it.
    this.idle.restartWatcher(accountId);
    void this.idle.refreshWatchers().catch((err) => {
      this.logger.warn(
        `IDLE watcher refresh after verify failed accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    });
  }
}
