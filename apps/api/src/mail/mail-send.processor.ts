import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { MAIL_SEND_CONCURRENCY, MAIL_SEND_QUEUE, type MailJobData } from './mail.queue';
import { MailSendService } from './mail-send.service';

/**
 * Dedicated worker for outbound user mail. Runs several sends in parallel so
 * one slow SMTP handshake (or a throttled relay) never blocks everyone else's
 * mail, and never waits behind IMAP sync jobs on the general `mail` queue.
 */
@Processor(MAIL_SEND_QUEUE, { concurrency: MAIL_SEND_CONCURRENCY })
export class MailSendProcessor extends WorkerHost {
  private readonly logger = new Logger(MailSendProcessor.name);

  constructor(private readonly sendService: MailSendService) {
    super();
  }

  async process(job: Job<MailJobData>): Promise<void> {
    if (job.data.kind !== 'send') {
      this.logger.warn(`Unexpected job kind on ${MAIL_SEND_QUEUE}: ${job.data.kind}`);
      return;
    }
    await this.sendService.processSend(job.data.outboxId);
  }
}
