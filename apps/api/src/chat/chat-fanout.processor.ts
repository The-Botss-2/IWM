import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { CHAT_FANOUT_CONCURRENCY, CHAT_FANOUT_QUEUE, type ChatFanoutJobData } from './chat-fanout.queue';
import { ChatService } from './chat.service';

/** Worker for chat message fan-out (OS push + bell rows). */
@Processor(CHAT_FANOUT_QUEUE, { concurrency: CHAT_FANOUT_CONCURRENCY })
export class ChatFanoutProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatFanoutProcessor.name);

  constructor(private readonly chat: ChatService) {
    super();
  }

  async process(job: Job<ChatFanoutJobData>): Promise<void> {
    if (job.data.kind !== 'message') {
      this.logger.warn(`Unexpected job kind on ${CHAT_FANOUT_QUEUE}: ${String(job.data.kind)}`);
      return;
    }
    await this.chat.runMessageFanout(job.data);
  }
}
