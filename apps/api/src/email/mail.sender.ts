import { createTransport, type Transporter } from 'nodemailer';

import { resolvePublicHost } from '../mail/mail-ssrf';

/**
 * Clean HTML header banner used at the top of transactional emails.
 * Avoids base64 SVG data-URIs because Gmail strips them and corporate spam
 * filters flag inline SVGs for script injection/phishing risks.
 */
function emailHeader(): string {
  return `
    <div style="text-align:center;padding:20px 0 12px">
      <div style="display:inline-block;background:linear-gradient(135deg,#3a8fd6,#7c4fa8);color:#ffffff;font-family:system-ui,-apple-system,sans-serif;font-weight:800;font-size:15px;letter-spacing:2px;padding:8px 16px;border-radius:8px">THE BOTSS</div>
    </div>
  `;
}

/**
 * Plain (non-NestJS) mail sender. Lives outside the DI container so it can
 * be constructed in `main.ts` BEFORE NestFactory boots - Better Auth's
 * `sendResetPassword` callback is wired at `createAuth(...)` time, which
 * happens before Nest providers exist.
 *
 * If `SMTP_HOST` is unset we fall back to a logging transport so dev
 * environments keep working without a real SMTP server. The same instance
 * is later registered as a Nest provider for runtime consumers (workspace
 * invitations, etc.) - see `email.module.ts`.
 */
export interface MailSendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Where replies go, e.g. the organization's billing address. */
  replyTo?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface MailSendOutcome {
  messageId: string;
  response: string;
  accepted: string[];
  rejected: string[];
}

/**
 * SMTP response codes that signal a transient failure - the caller should retry
 * with backoff. Anything else (especially 5xx auth + recipient rejections) is
 * permanent and must NOT be retried, otherwise we'll burn through the SMTP
 * provider's rate limit retrying mail that will never deliver.
 */
const TRANSIENT_SMTP_CODES = new Set<number>([421, 450, 451, 452]);
const TRANSIENT_NET_ERRORS = new Set<string>([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ESOCKET',
]);

/** Tagged error so BullMQ workers can decide whether to retry. */
export class MailSendError extends Error {
  readonly transient: boolean;
  readonly code: string | number | undefined;
  readonly responseCode: number | undefined;

  constructor(
    message: string,
    opts: { transient: boolean; code?: string | number; responseCode?: number; cause?: unknown },
  ) {
    super(message);
    this.name = 'MailSendError';
    this.transient = opts.transient;
    this.code = opts.code;
    this.responseCode = opts.responseCode;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

function classify(err: unknown): MailSendError {
  // nodemailer throws `Error & { code?: string; responseCode?: number; response?: string }`.
  const e = err as { message?: string; code?: string | number; responseCode?: number };
  const code = typeof e?.code === 'string' || typeof e?.code === 'number' ? e.code : undefined;
  const responseCode = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  const transient =
    (responseCode !== undefined && TRANSIENT_SMTP_CODES.has(responseCode)) ||
    (typeof code === 'string' && TRANSIENT_NET_ERRORS.has(code));
  return new MailSendError(e?.message ?? 'SMTP send failed', {
    transient,
    code,
    responseCode,
    cause: err,
  });
}

function resolveSmtpRelay(env: NodeJS.ProcessEnv): {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
} | null {
  const host = env.MAIL_RELAY_HOST?.trim();
  const user = env.MAIL_RELAY_USER?.trim();
  const pass = env.MAIL_RELAY_PASSWORD || env.MAIL_RELAY_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number.parseInt(env.MAIL_RELAY_PORT ?? '587', 10),
    secure: (env.MAIL_RELAY_SECURE ?? 'false').toLowerCase() === 'true',
    user,
    pass,
  };
}

export class MailSender {
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private readonly stub: boolean;
  // Logger is plain console here because MailSender is constructed before the
  // Nest container exists (main.ts wires it for Better Auth's reset callback).
  // The Nest-aware `EmailService` wrapper logs at a higher level with structured
  // metadata; this is the inner-loop fallback.

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.from = cleanMailFrom(env.MAIL_FROM?.trim() || 'no-reply@localhost');
    const relay = resolveSmtpRelay(env);
    const host = relay?.host ?? env.SMTP_HOST?.trim();
    if (!host) {
      this.transporter = null;
      this.stub = true;
      return;
    }
    const port = relay ? relay.port : Number.parseInt(env.SMTP_PORT ?? '587', 10);
    const secure = relay ? relay.secure : (env.SMTP_SECURE ?? 'false').toLowerCase() === 'true';
    const auth = relay
      ? { user: relay.user, pass: relay.pass }
      : env.SMTP_USER && env.SMTP_PASSWORD
        ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
        : undefined;
    this.transporter = createTransport({
      host,
      port,
      secure,
      auth,
      connectionTimeout: 30_000, // nodemailer 10: covers DNS + connect + greeting + STARTTLS
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    this.stub = false;
  }

  isStub(): boolean {
    return this.stub;
  }

  getFromAddress(): string {
    return this.from;
  }

  /**
   * Confirm the SMTP transport accepts our credentials. Logs the outcome but
   * never throws - a real-world deploy where SMTP is briefly unreachable should
   * still boot, and individual sends will retry per-attempt.
   */
  async verify(): Promise<{ ok: true } | { ok: false; error: MailSendError }> {
    if (!this.transporter) {
      return {
        ok: false,
        error: new MailSendError('SMTP transport is not configured (STUB mode)', {
          transient: false,
        }),
      };
    }
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: classify(err) };
    }
  }

  /**
   * Send mail through the configured transport. Throws a `MailSendError`
   * tagged with `transient: boolean` so callers (or the BullMQ worker) can
   * decide whether to retry.
   *
   * Rejects immediately if no transport is configured.
   */
  async send(args: MailSendArgs): Promise<MailSendOutcome> {
    if (!this.transporter) {
      // eslint-disable-next-line no-console
      console.log(
        `[MAIL_STUB] to=${args.to} subject=${JSON.stringify(args.subject)}\n${args.text}`,
      );
      throw new MailSendError('No SMTP transport configured (STUB mode)', { transient: false });
    }
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: stripHeaderUnsafe(args.to),
        subject: stripHeaderUnsafe(args.subject),
        html: args.html,
        text: args.text,
        ...(args.replyTo ? { replyTo: stripHeaderUnsafe(args.replyTo) } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });

      const rejected = (info.rejected ?? []) as string[];
      const accepted = (info.accepted ?? []) as string[];
      if (rejected.length > 0 && rejected.includes(args.to)) {
        throw new MailSendError(
          `Recipient rejected by SMTP server: ${rejected.join(', ')} (response: ${info.response ?? 'none'})`,
          {
            transient: false,
            responseCode:
              typeof info.response === 'string' ? Number.parseInt(info.response, 10) : undefined,
          },
        );
      }

      return {
        messageId: info.messageId ?? '',
        response: info.response ?? '',
        accepted,
        rejected,
      };
    } catch (err) {
      if (err instanceof MailSendError) throw err;
      throw classify(err);
    }
  }

  /**
   * Send via a per-MailAccount transport. Used by `EmailService` to deliver
   * transactional mail through whichever MailAccount the workspace has
   * configured (cPanel SMTP, custom provider, etc.) rather than the global
   * env-based transport. Each call builds and tears down a one-shot
   * `nodemailer` transporter so creds are never cached across requests.
   */
  async sendVia(
    creds: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
      from: string;
    },
    args: MailSendArgs,
  ): Promise<MailSendOutcome> {
    // creds.host comes from the org-level mail config (admin-supplied);
    // re-resolve and refuse private/internal targets before connecting.
    const target = await resolvePublicHost(creds.host);
    const transport = createTransport({
      host: target.host,
      ...(target.servername ? { tls: { servername: target.servername } } : {}),
      port: creds.port,
      secure: creds.secure,
      auth: { user: creds.user, pass: creds.pass },
      connectionTimeout: 30_000, // nodemailer 10: covers DNS + connect + greeting + STARTTLS
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    try {
      const info = await transport.sendMail({
        from: cleanMailFrom(creds.from),
        to: stripHeaderUnsafe(args.to),
        subject: stripHeaderUnsafe(args.subject),
        html: args.html,
        text: args.text,
        ...(args.replyTo ? { replyTo: stripHeaderUnsafe(args.replyTo) } : {}),
        ...(args.attachments ? { attachments: args.attachments } : {}),
      });

      const rejected = (info.rejected ?? []) as string[];
      const accepted = (info.accepted ?? []) as string[];
      if (rejected.length > 0 && rejected.includes(args.to)) {
        throw new MailSendError(
          `Recipient rejected by organization SMTP server: ${rejected.join(', ')} (response: ${info.response ?? 'none'})`,
          {
            transient: false,
            responseCode:
              typeof info.response === 'string' ? Number.parseInt(info.response, 10) : undefined,
          },
        );
      }

      return {
        messageId: info.messageId ?? '',
        response: info.response ?? '',
        accepted,
        rejected,
      };
    } catch (err) {
      if (err instanceof MailSendError) throw err;
      throw classify(err);
    } finally {
      transport.close();
    }
  }

  /**
   * One SMTP login for a batch of messages, e.g. a month's payslips sent from
   * an HR mailbox whose password was typed in for this request. The login is
   * checked before `fn` runs, so a wrong password throws (EAUTH) before
   * anything is sent and costs exactly one failed login on the mail host.
   * Messages share one connection and go out at most one per second, which
   * keeps shared hosts from rate-limiting the mailbox. Nothing is cached.
   */
  async withSession<T>(
    login: { host: string; port: number; secure: boolean; user: string; pass: string },
    fn: (
      send: (args: MailSendArgs & { from: { name: string; address: string } }) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    // The host is typed by the user; refuse private/internal targets.
    const target = await resolvePublicHost(login.host);
    const transport = createTransport({
      pool: true,
      maxConnections: 1,
      rateDelta: 1000,
      rateLimit: 1,
      host: target.host,
      ...(target.servername ? { tls: { servername: target.servername } } : {}),
      port: login.port,
      secure: login.secure,
      auth: { user: login.user, pass: login.pass },
      connectionTimeout: 30_000, // nodemailer 10: covers DNS + connect + greeting + STARTTLS
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    });
    try {
      try {
        await transport.verify();
      } catch (err) {
        throw classify(err);
      }
      return await fn(async (args) => {
        try {
          await transport.sendMail({
            from: {
              name: stripHeaderUnsafe(args.from.name),
              address: stripHeaderUnsafe(args.from.address),
            },
            to: stripHeaderUnsafe(args.to),
            subject: stripHeaderUnsafe(args.subject),
            html: args.html,
            text: args.text,
            ...(args.replyTo ? { replyTo: stripHeaderUnsafe(args.replyTo) } : {}),
            ...(args.attachments ? { attachments: args.attachments } : {}),
          });
        } catch (err) {
          throw classify(err);
        }
      });
    } finally {
      transport.close();
    }
  }
}

/**
 * Strip CRLF (and NUL) from values that land in SMTP headers. Nodemailer
 * already MIME-encodes most fields, but a defence-in-depth strip protects
 * against future thinning of that path and makes the contract explicit at
 * the boundary. Whitespace is normalised to single spaces.
 */
function stripHeaderUnsafe(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim();
}

/**
 * Format an email address that may contain a display name (e.g. "IWM <no-reply@example.com>")
 * and strip accidental outer quotes introduced in .env files so Nodemailer emits a clean RFC 5322 header.
 */
export function cleanMailFrom(value: string): string {
  const cleaned = stripHeaderUnsafe(value)
    .replace(/^["']|["']$/g, '')
    .trim();
  const match = cleaned.match(/^(.*?)\s*<([^>]+)>$/);
  if (match && match[2]) {
    const name = match[1]
      ?.trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    const address = match[2].trim();
    return name ? `${name} <${address}>` : address;
  }
  return cleaned;
}

export function renderResetPasswordEmail(args: { recipientName: string | null; url: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const name = args.recipientName?.trim() || 'there';
  const subject = 'Reset your password';
  const text = [
    `Hi ${name},`,
    '',
    'We received a request to reset your password. Click the link below to choose a new one. The link expires in 1 hour.',
    '',
    args.url,
    '',
    "If you didn't request a reset, you can safely ignore this email.",
    '',
    '- The Botss',
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      ${emailHeader()}
      <h2 style="margin:24px 0 16px;font-size:18px">Reset your password</h2>
      <p style="margin:0 0 12px">Hi ${escapeHtml(name)},</p>
      <p style="margin:0 0 16px">We received a request to reset your password. Click the button below to choose a new one. The link expires in 1 hour.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(args.url)}" style="background:#4f46e5;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">Reset password</a>
      </p>
      <p style="margin:0 0 12px;color:#475569;font-size:13px">Or paste this link into your browser:</p>
      <p style="margin:0 0 24px;color:#475569;font-size:13px;word-break:break-all">${escapeHtml(args.url)}</p>
      <p style="margin:0;color:#94a3b8;font-size:12px">If you didn't request a reset, you can safely ignore this email.</p>
    </div>
  `;
  return { subject, html, text };
}

/**
 * Workspace invitation. Neutral wording for the same deliverability reasons
 * as renderSignatureRequestEmail. `url` carries the unguessable link token
 * and `code` the 6-digit second factor the accept page asks for; the code is
 * kept out of the subject. A null code only happens for jobs queued before
 * codes existed, whose links no longer open.
 */
export function renderInvitationEmail(args: {
  recipientName: string | null;
  workspaceName: string;
  inviterName: string | null;
  url: string;
  code: string | null;
}): { subject: string; html: string; text: string } {
  const code = args.code ?? '';
  const name = args.recipientName ? ` ${args.recipientName}` : '';
  const subject = stripHeaderUnsafe(`Your ${args.workspaceName} code`);

  const text = [
    `Hi${name},`,
    '',
    `Your code for ${args.workspaceName} is:`,
    code,
    '',
    'Open your invitation here:',
    args.url,
    '',
    'See you on The Botss.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <div style="text-align:center;padding:12px 0 20px">
        <div style="display:inline-block;background:linear-gradient(135deg,#3a8fd6,#7c4fa8);color:#ffffff;font-weight:800;font-size:14px;letter-spacing:2px;padding:6px 14px;border-radius:6px">THE BOTSS</div>
      </div>
      <p style="margin:0 0 12px;font-size:15px">Hi${escapeHtml(name)},</p>
      <p style="margin:0 0 20px;font-size:15px">Your code for <strong>${escapeHtml(args.workspaceName)}</strong> is:</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
        <div style="font-size:32px;font-weight:700;letter-spacing:4px;color:#4f46e5;font-family:Consolas,monospace">${escapeHtml(code)}</div>
      </div>
      <p style="margin:20px 0;text-align:center">
        <a href="${escapeHtml(args.url)}" style="background:#4f46e5;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Join Workspace</a>
      </p>
      <p style="margin:16px 0 4px;color:#64748b;font-size:13px;text-align:center">Or paste this link into your browser:</p>
      <p style="margin:0;color:#64748b;font-size:12px;text-align:center;word-break:break-all">${escapeHtml(args.url)}</p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;text-align:center">See you on The Botss.</p>
    </div>
  `;
  return { subject, html, text };
}

export function renderInvoiceEmail(args: {
  companyName: string;
  invoiceNumber: string;
  total: string;
  dueDate: string | null;
  message: string | null;
}): { html: string; text: string } {
  const lines = [
    args.message?.trim() || `Please find invoice ${args.invoiceNumber} attached.`,
    '',
    `Invoice: ${args.invoiceNumber}`,
    `Amount due: ${args.total}`,
    ...(args.dueDate ? [`Due: ${args.dueDate}`] : []),
    '',
    `- ${args.companyName}`,
  ];
  const text = lines.join('\n');
  const message = escapeHtml(
    args.message?.trim() || `Please find invoice ${args.invoiceNumber} attached.`,
  ).replace(/\r?\n/g, '<br>');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      <p style="margin:0 0 20px;line-height:1.6">${message}</p>
      <table style="border-collapse:collapse;font-size:14px;margin:0 0 20px">
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Invoice</td><td style="padding:4px 0;font-weight:600">${escapeHtml(args.invoiceNumber)}</td></tr>
        <tr><td style="padding:4px 16px 4px 0;color:#64748b">Amount due</td><td style="padding:4px 0;font-weight:600">${escapeHtml(args.total)}</td></tr>
        ${args.dueDate ? `<tr><td style="padding:4px 16px 4px 0;color:#64748b">Due</td><td style="padding:4px 0">${escapeHtml(args.dueDate)}</td></tr>` : ''}
      </table>
      <p style="margin:0;color:#64748b;font-size:13px">The invoice is attached as a PDF.</p>
      <p style="margin:16px 0 0;color:#0f172a">${escapeHtml(args.companyName)}</p>
    </div>
  `;
  return { html, text };
}

export function renderPayslipEmail(args: {
  companyName: string;
  employeeName: string;
  period: string;
}): { subject: string; html: string; text: string } {
  const subject = `Payslip for ${args.period} - ${args.companyName}`;
  const text = [
    `Hi ${args.employeeName},`,
    '',
    `Your payslip for ${args.period} is attached as a PDF.`,
    '',
    `- ${args.companyName}`,
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      <p style="margin:0 0 16px;line-height:1.6">Hi ${escapeHtml(args.employeeName)},</p>
      <p style="margin:0 0 20px;line-height:1.6">Your payslip for ${escapeHtml(args.period)} is attached as a PDF.</p>
      <p style="margin:16px 0 0;color:#0f172a">${escapeHtml(args.companyName)}</p>
    </div>
  `;
  return { subject, html, text };
}

const BUTTON_STYLE =
  'background:#4f46e5;color:#ffffff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block';

function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

/**
 * Keep this copy deliberately neutral. Gmail's phishing heuristics block
 * credential-style phrases ("access code", "activate your account", "sign
 * document") coming from IPs without sending reputation, while the same
 * content reworded as "Your code is X." is delivered. Verified with A/B
 * sends to Gmail from a cPanel mail host (SPF/DKIM/DMARC all pass, so this
 * is purely content scoring).
 *
 * Two factors travel in this one email: `url` carries the unguessable link
 * token and `code` the 6-digit code the page asks for. The code is kept out
 * of the subject so it does not show on lock-screen previews. A null code
 * only happens for jobs queued before codes existed; those links no longer
 * open anyway.
 */
export function renderSignatureRequestEmail(args: {
  signerName: string | null;
  requesterName: string;
  workspaceName: string;
  title: string;
  message: string | null;
  url: string;
  code: string | null;
  expiresAtLabel: string;
}): { subject: string; html: string; text: string } {
  const code = args.code ?? '';
  const name = args.signerName ? ` ${args.signerName}` : '';
  const requester = args.requesterName.trim() || args.workspaceName;
  const subject = stripHeaderUnsafe(`Your code for "${args.title}"`);

  const text = [
    `Hi${name},`,
    '',
    `${requester} (${args.workspaceName}) shared "${args.title}" for your review.`,
    '',
    `Your code: ${code}.`,
    '',
    'Open the document here:',
    args.url,
    '',
    `Available until ${args.expiresAtLabel}.`,
    '',
    'See you on The Botss.',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <div style="text-align:center;padding:12px 0 20px">
        <div style="display:inline-block;background:linear-gradient(135deg,#3a8fd6,#7c4fa8);color:#ffffff;font-weight:800;font-size:14px;letter-spacing:2px;padding:6px 14px;border-radius:6px">THE BOTSS</div>
      </div>
      <p style="margin:0 0 12px;font-size:15px">Hi${escapeHtml(name)},</p>
      <p style="margin:0 0 16px;font-size:15px"><strong>${escapeHtml(requester)}</strong> (${escapeHtml(args.workspaceName)}) shared "<strong>${escapeHtml(args.title)}</strong>" for your review.</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;text-align:center;margin:20px 0">
        <div style="font-size:12px;letter-spacing:1px;color:#64748b;margin-bottom:6px">Your code</div>
        <div style="font-size:32px;font-weight:700;letter-spacing:4px;color:#4f46e5;font-family:Consolas,monospace">${escapeHtml(code)}</div>
      </div>
      <p style="margin:20px 0;text-align:center">
        <a href="${escapeHtml(args.url)}" style="background:#4f46e5;color:#ffffff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Open Document</a>
      </p>
      <p style="margin:16px 0 4px;color:#64748b;font-size:13px;text-align:center">Or paste this link into your browser:</p>
      <p style="margin:0 0 16px;color:#64748b;font-size:12px;text-align:center;word-break:break-all">${escapeHtml(args.url)}</p>
      <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center">Available until ${escapeHtml(args.expiresAtLabel)}.</p>
      <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;text-align:center">See you on The Botss.</p>
    </div>
  `;
  return { subject, html, text };
}

/**
 * Client portal mail. One renderer, three variants, so the invite, the
 * "you now have access" notice and the password reset read as one product.
 */
export function renderClientPortalEmail(args: {
  variant: 'invite' | 'access' | 'reset';
  recipientName: string | null;
  agencyName: string;
  clientName: string;
  inviterName: string | null;
  url: string;
  expiresAtLabel: string | null;
}): { subject: string; html: string; text: string } {
  const who = args.inviterName?.trim() || args.agencyName;
  const greeting = `Hi${args.recipientName ? ' ' + args.recipientName : ''},`;
  const what =
    'There you can follow the progress of your projects, read documents we share with you, and sign documents.';
  const copy = {
    invite: {
      subject: `${who} invited you to the ${args.agencyName} client portal`,
      heading: `Your ${args.agencyName} client portal`,
      lead: `${who} invited you to the client portal for ${args.clientName}.`,
      button: 'Set up your account',
      after: 'Choose a password to finish setting up your account.',
    },
    access: {
      subject: `You now have access to ${args.clientName} in the ${args.agencyName} client portal`,
      heading: `${args.clientName} was added to your portal`,
      lead: `${who} gave you access to ${args.clientName} in the ${args.agencyName} client portal.`,
      button: 'Open the portal',
      after: 'Sign in with your existing password.',
    },
    reset: {
      subject: `Choose a new password for the ${args.agencyName} client portal`,
      heading: 'Choose a new password',
      lead: `${who} sent you a link to choose a new password for the ${args.agencyName} client portal.`,
      button: 'Choose a new password',
      after: 'Your current password keeps working until you choose a new one.',
    },
  }[args.variant];
  const expiry = args.expiresAtLabel ? `This link expires on ${args.expiresAtLabel}.` : '';
  const text = [
    greeting,
    '',
    copy.lead,
    ...(args.variant === 'reset' ? [] : [what]),
    '',
    `${copy.after}`,
    args.url,
    '',
    ...(expiry ? [expiry, ''] : []),
    "If you weren't expecting this, you can safely ignore the email.",
    '',
    `- ${args.agencyName}`,
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      ${emailHeader()}
      <h2 style="margin:24px 0 16px;font-size:18px">${escapeHtml(copy.heading)}</h2>
      <p style="margin:0 0 12px">${escapeHtml(greeting)}</p>
      <p style="margin:0 0 12px">${escapeHtml(copy.lead)}</p>
      ${args.variant === 'reset' ? '' : `<p style="margin:0 0 16px;color:#334155">${escapeHtml(what)}</p>`}
      <p style="margin:24px 0">
        <a href="${escapeHtml(args.url)}" style="${BUTTON_STYLE}">${escapeHtml(copy.button)}</a>
      </p>
      <p style="margin:0 0 12px;color:#475569;font-size:13px">Or paste this link into your browser:</p>
      <p style="margin:0 0 24px;color:#475569;font-size:13px;word-break:break-all">${escapeHtml(args.url)}</p>
      ${expiry ? `<p style="margin:0 0 8px;color:#94a3b8;font-size:12px">${escapeHtml(expiry)}</p>` : ''}
      <p style="margin:0;color:#94a3b8;font-size:12px">If you weren't expecting this, you can safely ignore the email.</p>
    </div>
  `;
  return { subject: stripHeaderUnsafe(copy.subject), html, text };
}

export function renderSignatureCompletedEmail(args: {
  title: string;
  workspaceName: string;
  signedSha256: string;
}): { subject: string; html: string; text: string } {
  const subject = `Signed: "${args.title}"`;
  const text = [
    `Everyone has signed "${args.title}" (${args.workspaceName}).`,
    '',
    'The signed PDF is attached. Its last page is the signature certificate.',
    '',
    `SHA-256 fingerprint of the signed file: ${args.signedSha256}`,
    '',
    '- The Botss',
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      ${emailHeader()}
      <h2 style="margin:24px 0 16px;font-size:18px">Everyone has signed</h2>
      <p style="margin:0 0 12px">"<strong>${escapeHtml(args.title)}</strong>" from ${escapeHtml(args.workspaceName)} is fully signed. The signed PDF is attached, and its last page is the signature certificate.</p>
      <p style="margin:16px 0 4px;color:#475569;font-size:13px">SHA-256 fingerprint of the signed file:</p>
      <p style="margin:0 0 24px;font-family:Consolas,monospace;font-size:12px;word-break:break-all;color:#0f172a">${escapeHtml(args.signedSha256)}</p>
      <p style="margin:0;color:#94a3b8;font-size:12px">Keep this email. The fingerprint lets you prove the file was not changed later.</p>
    </div>
  `;
  return { subject, html, text };
}

export function renderSignatureDeclinedEmail(args: {
  title: string;
  signerEmail: string;
  reason: string;
  url: string;
}): { subject: string; html: string; text: string } {
  const subject = `${args.signerEmail} declined to sign "${args.title}"`;
  const text = [
    `${args.signerEmail} declined to sign "${args.title}".`,
    '',
    `Reason: ${args.reason}`,
    '',
    'The request is closed. You can send a new one from the document:',
    args.url,
    '',
    '- The Botss',
  ].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      ${emailHeader()}
      <h2 style="margin:24px 0 16px;font-size:18px">Signature declined</h2>
      <p style="margin:0 0 12px">${escapeHtml(args.signerEmail)} declined to sign "<strong>${escapeHtml(args.title)}</strong>".</p>
      <p style="margin:0 0 16px;padding:12px 14px;background:#fef2f2;border-radius:8px;color:#7f1d1d;line-height:1.6">${multiline(args.reason)}</p>
      <p style="margin:0 0 24px">The request is closed. You can send a new one from the document.</p>
      <p style="margin:0"><a href="${escapeHtml(args.url)}" style="${BUTTON_STYLE}">Open the document</a></p>
    </div>
  `;
  return { subject, html, text };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
