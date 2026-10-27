import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { SignaturesService } from './signatures.service';
import { SEAL_JOB_OPTIONS, type SealJobData, SIGNATURES_QUEUE } from './signature.queue';

/** Builds the sealed PDF once every signer has signed. */
@Processor(SIGNATURES_QUEUE, { concurrency: 2 })
export class SignatureSealProcessor extends WorkerHost {
  private readonly logger = new Logger(SignatureSealProcessor.name);

  constructor(private readonly signatures: SignaturesService) {
    super();
  }

  async process(job: Job<SealJobData>): Promise<void> {
    await this.signatures.seal(job.data.requestId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SealJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? SEAL_JOB_OPTIONS.attempts;
    this.logger.error(
      `Seal failed requestId=${job.data.requestId} attempt=${job.attemptsMade}/${attempts} message=${err?.message ?? 'unknown'}`,
    );
    if (job.attemptsMade >= attempts) {
      await this.signatures.recordSealFailure(job.data.requestId, err?.message ?? 'unknown');
    }
  }
}
