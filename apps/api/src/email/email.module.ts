import { BullModule } from '@nestjs/bullmq';
import {
  forwardRef,
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';

import { PROCESS_ROLE, type ProcessRole, runsBackgroundWork } from '../common/process-role';

import { FilesModule } from '../files/files.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EmailController } from './email.controller';
import { EmailProcessor } from './email.processor';
import { EMAIL_QUEUE } from './email.queue';
import { EmailService, MAIL_SENDER } from './email.service';
import { MailSender } from './mail.sender';

/**
 * Singleton `MailSender` shared between `main.ts` (Better Auth's
 * `sendResetPassword` callback) and the Nest container (workspace invites,
 * the BullMQ worker). Both paths must use the same transport so SMTP
 * credentials are read once.
 */
const sharedSender = new MailSender();

export function getSharedMailSender(): MailSender {
  return sharedSender;
}

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ name: EMAIL_QUEUE }),
    FilesModule,
    forwardRef(() => OrganizationsModule),
  ],
  controllers: [EmailController],
  providers: [
    EmailService,
    EmailProcessor,
    { provide: MAIL_SENDER, useValue: sharedSender },
  ],
  // MAIL_SENDER: payroll sends payslips through a typed-in mailbox login.
  exports: [EmailService, MAIL_SENDER],
})
export class EmailModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(EmailModule.name);

  constructor(@Optional() @Inject(PROCESS_ROLE) private readonly role: ProcessRole = 'all') {}

  async onApplicationBootstrap(): Promise<void> {
    // Every boot-time verify is a live SMTP AUTH (see the cPHulk note in
    // main.ts). With ROLE=api + ROLE=worker, only the worker, which sends the
    // queued mail, verifies; the api would just double the login count.
    // The inline admin test send still works in the api process.
    if (!runsBackgroundWork(this.role)) {
      this.logger.log('Boot-time SMTP verify runs in the worker process (ROLE=api here).');
      return;
    }
    // Escape hatch for when you know the SMTP creds are wrong but still need
    // the API up. Without this, every restart triggers another failed login
    // attempt - which (as we learned the hard way) trips cPHulk and bans the
    // whole server IP after ~4 strikes. Set `SMTP_SKIP_VERIFY=true` in the env
    // to skip the boot-time check; transactional sends still try and fail
    // with their own retry/backoff, but you don't burn the brute-force budget
    // on every restart.
    if ((process.env.SMTP_SKIP_VERIFY ?? '').toLowerCase() === 'true') {
      this.logger.warn(
        'SMTP_SKIP_VERIFY=true - skipping boot-time SMTP verification. Set this back to false once creds are confirmed working.',
      );
      return;
    }
    // Run SMTP verify once on boot. Failure is logged loudly but never crashes
    // the app - transient outages shouldn't take the whole API down, and
    // per-send retries will surface the same error in the worker logs.
    if (sharedSender.isStub()) {
      // System email (invitations) never borrows a personal MailAccount any
      // more, so without SMTP_* only organizations with their own mail config
      // can send. Say so loudly: this is the one setting to fix.
      this.logger.error(
        'SMTP_HOST is not set. Invitations and other system email will only send for organizations with a mail config; everything else is logged, not sent. Configure SMTP_* with the no-reply@ mailbox.',
      );
      return;
    }
    const result = await sharedSender.verify();
    if (result.ok) {
      this.logger.log('SMTP verify succeeded - transport ready to deliver mail.');
    } else {
      this.logger.error(
        `SMTP verify FAILED. transient=${result.error.transient} code=${result.error.code ?? 'unknown'} ` +
          `responseCode=${result.error.responseCode ?? 'unknown'} message=${result.error.message}`,
      );
    }
  }
}
