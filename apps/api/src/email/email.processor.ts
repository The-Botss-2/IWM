import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';

import { MailCryptoService } from '../mail/mail-crypto.service';
import { MailSendService } from '../mail/mail-send.service';
import { FilesService } from '../files/files.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { MAIL_SENDER } from './email.service';
import { EMAIL_QUEUE, type EmailJobData } from './email.queue';
import {
  MailSendError,
  type MailSendArgs,
  MailSender,
  renderClientPortalEmail,
  renderInvitationEmail,
  renderInvoiceEmail,
  renderResetPasswordEmail,
  renderSignatureCompletedEmail,
  renderSignatureDeclinedEmail,
  renderSignatureRequestEmail,
} from './mail.sender';

/**
 * BullMQ worker for transactional email (password reset, workspace invite,
 * admin test).
 *
 * Send precedence (highest to lowest):
 *   1. `OrganizationMailConfig` for the job's `organizationId` (if set) -
 *      org-wide outbound credentials, decrypted in memory.
 *   2. Global `MailSender` env transport (`SMTP_*`, normally the
 *      no-reply@ mailbox or a relay) - the platform default.
 *   3. Stub: logged, not sent.
 *
 * A personal `MailAccount` is NEVER used. The old first step picked "any
 * ACTIVE mailbox" with no tenant filter, so every organization's invitations
 * went out through one arbitrary employee's own SMTP login, from their
 * address, into their Sent folder.
 *
 * Permanent failures (auth, bad recipients) throw `UnrecoverableError` so
 * BullMQ stops retrying; transient failures bubble for exponential backoff.
 */
@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailProcessor.name);

  constructor(
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    // Optional so this processor still boots in environments that
    // haven't pulled in OrganizationsModule yet (tests, dev sandboxes).
    @Optional() private readonly organizations?: OrganizationsService,
    @Optional() private readonly mailCrypto?: MailCryptoService,
    @Optional() private readonly mailSend?: MailSendService,
  ) {
    super();
  }

  async process(job: Job<EmailJobData>): Promise<void> {
    const data = job.data;
    const rendered = render(data);

    // Invoice mail carries the PDF and a Reply-To; everything else is plain.
    const extras: Pick<MailSendArgs, 'attachments' | 'replyTo'> = {};
    if (data.kind === 'invoice') {
      const pdf = await this.files.getObjectBuffer(data.workspaceId, data.pdfFileId);
      if (!pdf) {
        throw new UnrecoverableError(`Invoice PDF ${data.pdfFileId} not found`);
      }
      extras.attachments = [
        { filename: `${data.invoiceNumber}.pdf`, content: pdf.body, contentType: 'application/pdf' },
      ];
      if (data.replyTo) extras.replyTo = data.replyTo;
    }
    if (data.kind === 'signature-request' && data.replyTo) {
      extras.replyTo = data.replyTo;
    }
    if (data.kind === 'signature-completed') {
      // includeDeleted: the sealed PDF must still attach if someone removed
      // the FileObject from the Files list in the meantime.
      const pdf = await this.files.getObjectBuffer(data.workspaceId, data.pdfFileId, {
        includeDeleted: true,
      });
      if (!pdf) {
        throw new UnrecoverableError(`Signed PDF ${data.pdfFileId} not found`);
      }
      extras.attachments = [
        { filename: data.filename, content: pdf.body, contentType: 'application/pdf' },
      ];
    }

    try {
      // Org-level mail config, if the producer told us which org we're
      // acting on behalf of.
      if (data.organizationId && this.organizations) {
        const orgCreds = await this.organizations.resolveDecryptedMailConfig(
          data.organizationId,
        );
        if (orgCreds) {
          const outcome = await this.sender.sendVia(
            {
              host: orgCreds.smtpHost,
              port: orgCreds.smtpPort,
              secure: orgCreds.smtpSecure,
              user: orgCreds.smtpUser,
              pass: orgCreds.smtpPassword,
              from: orgCreds.fromEmail,
            },
            {
              to: data.to,
              subject: rendered.subject,
              html: rendered.html,
              text: rendered.text,
              ...extras,
            },
          );
          this.logger.log(
            `Email accepted by OrganizationMailConfig kind=${data.kind} to=${data.to} orgId=${data.organizationId} messageId=${outcome.messageId} response=${JSON.stringify(outcome.response)} attempt=${job.attemptsMade + 1}`,
          );
          return;
        }
      }

      // Dedicated MailAccount (e.g. the MAIL_FROM no-reply address imported into the app).
      // Uses the CRM's MailSendService outbox pipeline to send raw RFC 822 MIME
      // and append a copy to the IMAP Sent folder, exactly like user webmail!
      if (this.mailSend) {
        const fromHeader = this.sender.getFromAddress() || 'no-reply@localhost';
        const bareEmail = (fromHeader.match(/<([^>]+)>/)?.[1] ?? fromHeader).trim();
        const mailAccount = await this.prisma.client.mailAccount.findFirst({
          where: {
            email: { equals: bareEmail, mode: 'insensitive' },
            deletedAt: null,
            status: 'ACTIVE',
          },
        });
        if (mailAccount) {
          try {
            const outbox = await this.mailSend.enqueue(mailAccount.userId, {
              accountId: mailAccount.id,
              to: [data.to],
              subject: rendered.subject,
              bodyText: rendered.text,
              bodyHtml: rendered.html,
            });
            this.logger.log(
              `Email enqueued via MailSendService kind=${data.kind} to=${data.to} outboxId=${outbox.id} accountId=${mailAccount.id} email=${mailAccount.email}`,
            );
            return;
          } catch (err) {
            this.logger.warn(
              `MailSendService enqueue failed for ${mailAccount.email}, falling back: ${(err as Error)?.message ?? 'unknown'}`,
            );
          }
        }
      }

      if (this.sender.isStub()) {
        this.logger.error(
          `Email NOT sent (no transport configured / STUB mode) kind=${data.kind} to=${data.to}. Set SMTP_* (no-reply mailbox) or the organization mail config.`,
        );
        throw new UnrecoverableError('No mail transport configured');
      }
      const outcome = await this.sender.send({
        to: data.to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...extras,
      });
      this.logger.log(
        `Email accepted by SMTP transport kind=${data.kind} to=${data.to} messageId=${outcome.messageId} response=${JSON.stringify(outcome.response)} accepted=${outcome.accepted.join(',')} rejected=${outcome.rejected.join(',')} attempt=${job.attemptsMade + 1}`,
      );
    } catch (err) {
      const me = err instanceof MailSendError ? err : null;
      // Never log message bodies (PII). Only structured failure metadata.
      this.logger.error(
        `Email send failed kind=${data.kind} to=${data.to} attempt=${job.attemptsMade + 1} ` +
          `transient=${me?.transient ?? 'unknown'} code=${me?.code ?? 'unknown'} ` +
          `responseCode=${me?.responseCode ?? 'unknown'} message=${(err as Error)?.message ?? ''}`,
      );
      if (me && !me.transient) {
        throw new UnrecoverableError(me.message);
      }
      throw err;
    }
  }
}

function render(data: EmailJobData): { subject: string; html: string; text: string } {
  if (data.kind === 'invoice') {
    const body = renderInvoiceEmail({
      companyName: data.companyName,
      invoiceNumber: data.invoiceNumber,
      total: data.totalLabel,
      dueDate: data.dueDateLabel,
      message: data.message,
    });
    return { subject: data.subject, ...body };
  }
  switch (data.kind) {
    case 'password-reset':
      return renderResetPasswordEmail({
        recipientName: data.recipientName,
        url: data.url,
      });
    case 'workspace-invitation':
      return renderInvitationEmail({
        recipientName: data.recipientName,
        workspaceName: data.workspaceName,
        inviterName: data.inviterName,
        url: data.url,
        code: data.code ?? null,
      });
    case 'signature-request':
      return renderSignatureRequestEmail({
        signerName: data.signerName,
        requesterName: data.requesterName,
        workspaceName: data.workspaceName,
        title: data.title,
        message: data.message,
        url: data.url,
        code: data.code ?? null,
        expiresAtLabel: data.expiresAtLabel,
      });
    case 'signature-completed':
      return renderSignatureCompletedEmail({
        title: data.title,
        workspaceName: data.workspaceName,
        signedSha256: data.signedSha256,
      });
    case 'client-portal':
      return renderClientPortalEmail({
        variant: data.variant,
        recipientName: data.recipientName,
        agencyName: data.agencyName,
        clientName: data.clientName,
        inviterName: data.inviterName,
        url: data.url,
        expiresAtLabel: data.expiresAtLabel,
      });
    case 'signature-declined':
      return renderSignatureDeclinedEmail({
        title: data.title,
        signerEmail: data.signerEmail,
        reason: data.reason,
        url: data.url,
      });
    case 'test':
      return {
        subject: 'The Botss SMTP test',
        html: `<p>${escapeHtmlMin(data.message)}</p>`,
        text: data.message,
      };
  }
}

function escapeHtmlMin(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}
