import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';

import { assertHostnamePublic, resolvePublicHost } from './mail-ssrf';

export interface MailVerifyCreds {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  password: string;
}

export type MailVerifyOutcome = {
  imapOk: boolean;
  smtpOk: boolean;
  error: string | null;
  /** Suggested MailAccountStatus the caller should persist. */
  status: 'ACTIVE' | 'AUTH_FAILED' | 'CONNECTION_FAILED';
};

/**
 * Verifies IMAP + SMTP credentials against the live mail server.
 *
 * Slice 1 scope: SMTP only. This is sufficient to unblock the transactional
 * email path (password reset / workspace invite). IMAP verify lands in Slice
 * 2 alongside the imapflow-based sync engine; until then `imapOk` is reported
 * equal to `smtpOk` so the UI does not flag accounts as half-broken when
 * only the send path has actually been exercised. The structural contract
 * stays unchanged so callers do not need to update when IMAP verify arrives.
 *
 * Failure classification:
 *   - AUTH_FAILED: bad credentials, locked account, security policy
 *   - CONNECTION_FAILED: DNS, TLS, port, network
 */
@Injectable()
export class MailVerifierService {
  private readonly logger = new Logger(MailVerifierService.name);

  async verify(creds: MailVerifyCreds): Promise<MailVerifyOutcome> {
    try {
      await assertHostnamePublic(creds.smtpHost);
      await assertHostnamePublic(creds.imapHost);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Refused mail host verify: ${message}`);
      return {
        imapOk: false,
        smtpOk: false,
        error: message,
        status: 'CONNECTION_FAILED',
      };
    }
    const smtp = await this.verifySmtp(creds);
    return {
      imapOk: smtp.kind === 'ok',
      smtpOk: smtp.kind === 'ok',
      error: smtp.error,
      status:
        smtp.kind === 'auth'
          ? 'AUTH_FAILED'
          : smtp.kind === 'conn'
            ? 'CONNECTION_FAILED'
            : 'ACTIVE',
    };
  }

  private async verifySmtp(
    creds: MailVerifyCreds,
  ): Promise<{ kind: 'ok' | 'auth' | 'conn'; error: string | null }> {
    // Connect to the vetted address, keeping the name for TLS (DNS rebinding).
    let target: { host: string; servername: string | undefined };
    try {
      target = await resolvePublicHost(creds.smtpHost);
    } catch (err) {
      return { kind: 'conn', error: (err as Error).message };
    }
    const transporter = createTransport({
      host: target.host,
      ...(target.servername ? { tls: { servername: target.servername } } : {}),
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      auth: { user: creds.username, pass: creds.password },
      connectionTimeout: 30_000, // nodemailer 10: covers DNS + connect + greeting + STARTTLS
    });
    try {
      await transporter.verify();
      return { kind: 'ok', error: null };
    } catch (err) {
      const e = err as { code?: string; responseCode?: number; message?: string };
      const isAuth = e?.code === 'EAUTH' || (e?.responseCode ?? 0) === 535;
      this.logger.warn(
        `SMTP verify failed host=${creds.smtpHost} user=${creds.username} kind=${isAuth ? 'auth' : 'conn'} code=${e?.code ?? 'unknown'} responseCode=${e?.responseCode ?? 'unknown'}`,
      );
      return {
        kind: isAuth ? 'auth' : 'conn',
        error: humanise(e?.message ?? 'SMTP connection failed', isAuth ? 'auth' : 'conn'),
      };
    } finally {
      transporter.close();
    }
  }
}

function humanise(raw: string, kind: 'auth' | 'conn'): string {
  if (kind === 'auth') {
    return 'Login was rejected by the mail server. Check the mailbox password and that the account is not locked.';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Couldn't reach the mail server. Check the host, port, and that outbound network access to that port is allowed.";
  }
  return 'Mail server connection failed. Verify host, port, and TLS settings.';
}
