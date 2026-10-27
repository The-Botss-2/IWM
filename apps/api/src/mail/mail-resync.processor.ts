import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { MAIL_RESYNC_QUEUE, type MailJobData } from './mail.queue';
import { MailReadService } from './mail-read.service';

/**
 * Worker for manual folder resyncs. Concurrency 1: each job refetches every
 * UID of a folder, so they run one after another and never share the general
 * `mail` queue with verify-account and initial-sync. Like every @Processor it
 * gets no BullMQ Worker in ROLE=api (QueueModule's manualRegistration).
 */
@Processor(MAIL_RESYNC_QUEUE, { concurrency: 1 })
export class MailResyncProcessor extends WorkerHost {
  private readonly logger = new Logger(MailResyncProcessor.name);

  constructor(private readonly read: MailReadService) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    if (job.data.kind !== 'resync-folder') {
      this.logger.warn(`Unexpected job kind on ${MAIL_RESYNC_QUEUE}: ${job.data.kind}`);
      return;
    }
    await this.read.runFolderResync(job.data.accountId, job.data.folderId);
  }
}
