import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { EMAIL_JOB_OPTIONS, EMAIL_QUEUE, type EmailJobData } from './email.queue';
import { MailSender } from './mail.sender';

export const MAIL_SENDER = 'MAIL_SENDER';

/** How long a live SMTP verify result is reused by the health check. */
const VERIFY_CACHE_SECONDS = 300;

/**
 * Nest-aware email facade. Producers call these methods; the actual SMTP send
 * happens asynchronously on the BullMQ worker. We keep the per-method API the
 * existing callers (workspaces invites, Better Auth callbacks) rely on so this
 * change is a drop-in for callers - only the *path* from request to send moved.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJobData>,
    private readonly prisma: PrismaService,
    // Optional so contexts without RedisModule still construct the service;
    // only the health check's verify cache uses it.
    @Optional() private readonly redis?: RedisService,
  ) {}

  /**
   * Stub mode means we have NO viable transport. Without an org hint that
   * means env SMTP is unconfigured. With an org hint (workspace invite, org-bootstrap invite)
   * we also check `OrganizationMailConfig` for that tenant - if the tenant
   * has plugged in their own SMTP creds the processor can route through
   * those, so the global env transport being absent doesn't block us.
   *
   * Callers (admin test endpoint, etc.) short-circuit on `isStub() === true`
   * so they don't enqueue jobs that will only log to the worker.
   */
  async isStub(organizationId?: string): Promise<boolean> {
    if (!this.sender.isStub()) return false;
    if (organizationId) {
      const orgCfg = await this.prisma.client.organizationMailConfig.findUnique({
        where: { organizationId },
        select: { id: true },
      });
      if (orgCfg) return false;
    }
    return true;
  }

  /**
   * Enqueue helper that never throws. A Redis outage shouldn't block the
   * invite/reset HTTP response - the admin always gets the URL back in the
   * response body as a copy-paste fallback. Errors are logged and swallowed.
   * Returns true if successfully queued, false otherwise.
   */
  private async enqueueSafe(
    name: string,
    data: EmailJobData,
    context: string,
  ): Promise<boolean> {
    try {
      await this.queue.add(name, data, EMAIL_JOB_OPTIONS);
      this.logger.log(`Email queued kind=${data.kind} ${context}`);
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to enqueue email kind=${data.kind} ${context} message=${(err as Error)?.message ?? 'unknown'}`,
      );
      return false;
    }
  }

  async sendPasswordReset(args: {
    to: string;
    recipientName: string | null;
    url: string;
    organizationId?: string;
  }): Promise<{ queued: boolean; stub: boolean }> {
    if (await this.isStub(args.organizationId)) {
      this.logger.warn(`[MAIL_STUB] password reset for ${args.to} → ${args.url}`);
      return { queued: false, stub: true };
    }
    const queued = await this.enqueueSafe(
      'password-reset',
      { kind: 'password-reset', ...args },
      `to=${args.to} org=${args.organizationId ?? 'unset'}`,
    );
    return { queued, stub: false };
  }

  async sendWorkspaceInvitation(args: {
    to: string;
    recipientName: string | null;
    workspaceName: string;
    inviterName: string | null;
    url: string;
    /** The 6-digit second factor printed next to the link. Never logged. */
    code: string;
    /**
     * The tenant org the workspace belongs to. Forwarded so the BullMQ
     * processor can route through `OrganizationMailConfig` if the tenant
     * has plugged in their own SMTP credentials - without this hint the
     * processor falls straight through to the platform env transport,
     * which is the symptom that caused invites to silently not deliver
     * when env SMTP wasn't configured.
     */
    organizationId?: string;
  }): Promise<{ queued: boolean; stub: boolean }> {
    if (await this.isStub(args.organizationId)) {
      this.logger.warn(
        // No URL or code here: together they are a live credential.
        `[MAIL_STUB] invitation for ${args.to} (${args.workspaceName}) not emailed; share the link from the members page`,
      );
      return { queued: false, stub: true };
    }
    const queued = await this.enqueueSafe(
      'workspace-invitation',
      { kind: 'workspace-invitation', ...args },
      `to=${args.to} workspace=${args.workspaceName} org=${args.organizationId ?? 'unset'}`,
    );
    return { queued, stub: false };
  }

  /**
   * Email an invoice PDF from the platform address. The job carries the
   * stored PDF's file id, never the bytes, so Redis stays small.
   *
   * `queued` when at least one recipient's job is on the queue; delivery is
   * then the worker's job. `queue-failed` when Redis refused every job.
   */
  async sendInvoice(args: {
    to: string[];
    subject: string;
    message: string | null;
    replyTo: string | null;
    companyName: string;
    invoiceId: string;
    invoiceNumber: string;
    totalLabel: string;
    dueDateLabel: string | null;
    workspaceId: string;
    organizationId: string;
    pdfFileId: string;
  }): Promise<'queued' | 'not-configured' | 'queue-failed'> {
    if (await this.isStub(args.organizationId)) {
      this.logger.error(
        `Invoice ${args.invoiceNumber} NOT emailed: no system mail transport. Configure SMTP_* (no-reply mailbox).`,
      );
      return 'not-configured';
    }
    const failed: string[] = [];
    for (const to of args.to) {
      const ok = await this.enqueueSafe(
        'invoice',
        {
          kind: 'invoice',
          to,
          subject: args.subject,
          message: args.message,
          replyTo: args.replyTo,
          companyName: args.companyName,
          invoiceId: args.invoiceId,
          invoiceNumber: args.invoiceNumber,
          totalLabel: args.totalLabel,
          dueDateLabel: args.dueDateLabel,
          workspaceId: args.workspaceId,
          organizationId: args.organizationId,
          pdfFileId: args.pdfFileId,
        },
        `invoice=${args.invoiceNumber} to=${to}`,
      );
      if (!ok) failed.push(to);
    }
    if (failed.length === args.to.length) return 'queue-failed';
    if (failed.length > 0) {
      this.logger.error(
        `Invoice ${args.invoiceNumber} queued for some recipients only; NOT queued for: ${failed.join(', ')}`,
      );
    }
    return 'queued';
  }

  /**
   * E-signature emails. Each signer gets their own job so one bad address
   * never blocks the others. Returns false when no transport is configured,
   * so the caller can tell the requester to share the links by hand.
   */
  async sendSignatureRequests(
    organizationId: string | undefined,
    jobs: Array<{
      to: string;
      signerName: string | null;
      requesterName: string;
      workspaceName: string;
      title: string;
      message: string | null;
      url: string;
      code: string;
      expiresAtLabel: string;
      replyTo: string | null;
    }>,
  ): Promise<boolean> {
    if (await this.isStub(organizationId)) {
      this.logger.warn(
        'Signature request NOT emailed: no system mail transport. Configure SMTP_* (no-reply mailbox).',
      );
      return false;
    }
    let allQueued = true;
    for (const job of jobs) {
      const ok = await this.enqueueSafe(
        'signature-request',
        { kind: 'signature-request', ...job, ...(organizationId ? { organizationId } : {}) },
        `signature-request to=${job.to}`,
      );
      if (!ok) allQueued = false;
    }
    return allQueued;
  }

  async sendSignatureCompleted(
    organizationId: string | undefined,
    recipients: string[],
    args: {
      title: string;
      workspaceName: string;
      signedSha256: string;
      workspaceId: string;
      pdfFileId: string;
      filename: string;
    },
  ): Promise<void> {
    if (await this.isStub(organizationId)) return;
    for (const to of recipients) {
      await this.enqueueSafe(
        'signature-completed',
        { kind: 'signature-completed', to, ...args, ...(organizationId ? { organizationId } : {}) },
        `signature-completed to=${to}`,
      );
    }
  }

  async sendSignatureDeclined(
    organizationId: string | undefined,
    args: { to: string; title: string; signerEmail: string; reason: string; url: string },
  ): Promise<void> {
    if (await this.isStub(organizationId)) return;
    await this.enqueueSafe(
      'signature-declined',
      { kind: 'signature-declined', ...args, ...(organizationId ? { organizationId } : {}) },
      `signature-declined to=${args.to}`,
    );
  }

  /**
   * Client portal mail (invite, access notice, password reset). Returns false
   * when no transport is configured, so staff know to share the link by hand.
   * The URL carries a raw one-time token for invite and reset, so it is never
   * logged.
   */
  async sendClientPortalEmail(args: {
    variant: 'invite' | 'access' | 'reset';
    to: string;
    recipientName: string | null;
    agencyName: string;
    clientName: string;
    inviterName: string | null;
    url: string;
    expiresAtLabel: string | null;
    organizationId: string;
  }): Promise<boolean> {
    if (await this.isStub(args.organizationId)) {
      this.logger.error(
        `Client portal ${args.variant} NOT emailed to ${args.to}: no system mail transport. Configure SMTP_* (no-reply mailbox).`,
      );
      return false;
    }
    return this.enqueueSafe(
      'client-portal',
      { kind: 'client-portal', ...args },
      `client-portal variant=${args.variant} to=${args.to} org=${args.organizationId}`,
    );
  }

  /**
   * Describe the currently-active mail transport WITHOUT sending anything.
   * Used by the admin diagnostic UI to answer "why isn't my invitation
   * email going out?" - the operator can see at a glance which transport
   * is in play (env / MailAccount / OrganizationMailConfig / stub) and
   * whether the SMTP verify call succeeds against it.
   *
   * Returns sensitive fields (host, port, from) only - never passwords.
   */
  async describeTransport(orgId?: string): Promise<{
    transport: 'env' | 'org-mail-config' | 'stub';
    host: string | null;
    port: number | null;
    fromAddress: string | null;
    verify: { ok: true } | { ok: false; error: string } | null;
  }> {
    // Precedence mirrors EmailProcessor.process:
    //   1. OrganizationMailConfig (when an org hint is supplied)
    //   2. Platform env transport
    //   3. Stub (no transport at all)
    if (orgId) {
      const cfg = await this.prisma.client.organizationMailConfig.findUnique({
        where: { organizationId: orgId },
        select: { smtpHost: true, smtpPort: true, fromEmail: true },
      });
      if (cfg) {
        return {
          transport: 'org-mail-config',
          host: cfg.smtpHost,
          port: cfg.smtpPort,
          fromAddress: cfg.fromEmail,
          verify: null,
        };
      }
    }
    if (this.sender.isStub()) {
      return {
        transport: 'stub',
        host: null,
        port: null,
        fromAddress: null,
        verify: {
          ok: false,
          error: 'No SMTP transport configured (STUB mode). Set SMTP_HOST in environment.',
        },
      };
    }
    // Env transport. Pull host/port/from from the same env vars the
    // MailSender constructor consulted so the diagnostic reflects what's
    // actually in use, not a stale snapshot.
    const host = process.env.SMTP_HOST ?? null;
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
    const fromAddress = process.env.MAIL_FROM ?? null;
    return { transport: 'env', host, port, fromAddress, verify: await this.cachedEnvVerify() };
  }

  /**
   * A live SMTP verify is a real AUTH login. Repeating it on every health
   * call (a dashboard poll, an impatient admin) trips the relay's
   * brute-force protection (cPHulk can ban the whole server IP), so the
   * result is shared through Redis for VERIFY_CACHE_SECONDS. A Redis failure
   * falls back to verifying once, uncached.
   */
  private async cachedEnvVerify(): Promise<{ ok: true } | { ok: false; error: string }> {
    const key = 'mail:health:env-verify';
    try {
      const hit = await this.redis?.client.get(key);
      if (hit) return JSON.parse(hit) as { ok: true } | { ok: false; error: string };
    } catch {
      // Cache unavailable: verify below.
    }
    const result = await this.sender.verify();
    const verify: { ok: true } | { ok: false; error: string } = result.ok
      ? { ok: true }
      : { ok: false, error: `${result.error.code ?? 'unknown'}: ${result.error.message}` };
    try {
      await this.redis?.client.set(key, JSON.stringify(verify), 'EX', VERIFY_CACHE_SECONDS);
    } catch {
      // Best effort.
    }
    return verify;
  }

  /**
   * Admin-only test email. Bypasses the queue and sends inline so the operator
   * gets immediate feedback from the request - surfacing errors directly is the
   * whole point of the endpoint.
   */
  async sendTestInline(to: string, message: string): Promise<{ ok: boolean; error?: string }> {
    if (this.sender.isStub()) {
      return {
        ok: false,
        error:
          'SMTP transport is not configured (STUB mode). Please configure SMTP_HOST, SMTP_USER, and SMTP_PASSWORD in environment.',
      };
    }
    try {
      const outcome = await this.sender.send({
        to,
        subject: 'The Botss - SMTP test',
        html: `<p>${message.replace(/</g, '&lt;')}</p>`,
        text: message,
      });
      return {
        ok: true,
        error: outcome.response ? `Accepted by SMTP: ${outcome.response}` : undefined,
      };
    } catch (err) {
      const msg = (err as Error)?.message ?? 'Send failed';
      this.logger.error(`Test email failed to=${to} message=${msg}`);
      return { ok: false, error: msg };
    }
  }
}
