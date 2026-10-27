import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';

import { ImapIdleService } from './imap-idle.service';
import { ImapSyncService } from './imap-sync.service';
import { MailAccountsController } from './mail-accounts.controller';
import { MailAccountsService } from './mail-accounts.service';
import { MailCryptoService } from './mail-crypto.service';
import { MailEventsController } from './mail-events.controller';
import { MailEventsService } from './mail-events.service';
import { MailHostGovernor } from './mail-host-governor';
import { MailFoldersController } from './mail-folders.controller';
import { MailMessagesController } from './mail-messages.controller';
import { MailProcessor } from './mail.processor';
import { MAIL_QUEUE, MAIL_RESYNC_QUEUE, MAIL_SEND_QUEUE } from './mail.queue';
import { MailReadService } from './mail-read.service';
import { MailResyncProcessor } from './mail-resync.processor';
import { MailSendProcessor } from './mail-send.processor';
import { MailSendService } from './mail-send.service';
import { MailVerifierService } from './mail-verifier.service';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: MAIL_QUEUE }),
    BullModule.registerQueue({ name: MAIL_SEND_QUEUE }),
    BullModule.registerQueue({ name: MAIL_RESYNC_QUEUE }),
  ],
  controllers: [
    MailAccountsController,
    MailFoldersController,
    MailMessagesController,
    MailEventsController,
  ],
  providers: [
    MailAccountsService,
    MailCryptoService,
    MailVerifierService,
    MailSendService,
    MailReadService,
    ImapSyncService,
    ImapIdleService,
    MailHostGovernor,
    MailEventsService,
    MailProcessor,
    MailSendProcessor,
    MailResyncProcessor,
  ],
  exports: [
    MailAccountsService,
    MailCryptoService,
    MailReadService,
    MailSendService,
    ImapSyncService,
    ImapIdleService,
    MailEventsService,
  ],
})
export class MailModule {}
