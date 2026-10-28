import { HttpException, Injectable, Logger } from '@nestjs/common';

/**
 * cPanel UAPI client. Talks to the cPanel server's Email module over HTTPS
 * using a server-side API token. Used by the admin user-management flows to
 * keep CRM accounts in lock-step with cPanel mailboxes - create-user makes a
 * mailbox, password-change rotates the mailbox password, delete-user (when
 * configured) removes the mailbox.
 *
 * Required environment variables:
 *   CPANEL_HOST       e.g. "cpanel.example.com" or the bare server hostname
 *   CPANEL_PORT       optional, defaults to 2083
 *   CPANEL_USER       cPanel account username (the one that owns the domain)
 *   CPANEL_API_TOKEN  generated from cPanel → Manage API Tokens
 *   CPANEL_DOMAIN     the domain to provision mailboxes under, e.g.
 *                     "example.com"
 *
 * When `CPANEL_API_TOKEN` is unset the client logs a one-line warning and
 * goes into NO-OP mode: every call resolves silently. This keeps local dev
 * working without leaking real credentials and lets staging environments
 * be deployed before cPanel access is set up.
 */
export interface CpanelEmailAccount {
  email: string;
  /** Local part before the @, lowercased. */
  user: string;
  /** Domain after the @, lowercased. */
  domain: string;
  /** Quota in MB. 0 means unlimited. */
  quotaMb: number;
  /** Used disk in bytes (best-effort - some cPanel builds return strings). */
  diskUsedBytes: number;
}

@Injectable()
export class CpanelService {
  private readonly logger = new Logger(CpanelService.name);
  private readonly host: string | null;
  private readonly port: number;
  private readonly user: string | null;
  private readonly token: string | null;
  private readonly domain: string | null;

  constructor() {
    this.host = (process.env.CPANEL_HOST ?? '').trim() || null;
    this.port = Number.parseInt(process.env.CPANEL_PORT ?? '2083', 10);
    this.user = (process.env.CPANEL_USER ?? '').trim() || null;
    this.token = (process.env.CPANEL_API_TOKEN ?? '').trim() || null;
    this.domain = (process.env.CPANEL_DOMAIN ?? '').trim() || null;
    if (!this.host || !this.user || !this.token || !this.domain) {
      this.logger.warn(
        'cPanel UAPI not fully configured (CPANEL_HOST/USER/API_TOKEN/DOMAIN). Mailbox provisioning will no-op.',
      );
    }
  }

  isEnabled(): boolean {
    return !!(this.host && this.user && this.token && this.domain);
  }

  /** Returns whether the email's domain matches the configured cPanel domain.
   *  Used by callers to decide whether to call cPanel at all. */
  ownsEmail(email: string): boolean {
    if (!this.domain) return false;
    return email.toLowerCase().endsWith('@' + this.domain.toLowerCase());
  }

  /**
   * Create a mailbox via `Email::add_pop`. Returns `{ created: false }` if
   * the mailbox already exists on cPanel - callers treat this as an import
   * path rather than an error.
   */
  async createEmail(args: {
    email: string;
    password: string;
    quotaMb?: number;
  }): Promise<{ created: boolean }> {
    if (!this.isEnabled()) return { created: false };
    const [localPart, dom] = args.email.toLowerCase().split('@');
    if (!localPart || !dom || dom !== this.domain?.toLowerCase()) {
      throw new HttpException(
        `Cannot create ${args.email} because its domain does not match ${this.domain}. Use an address on that domain.`,
        400,
      );
    }

    const result = await this.uapi('Email', 'add_pop', {
      domain: dom,
      email: localPart,
      password: args.password,
      quota: String(args.quotaMb ?? 0),
      send_welcome_email: '0',
    });

    if (result.errors && result.errors.length > 0) {
      const message = result.errors.join('; ');
      // cPanel returns "<email> already exists" as a hard error. Treat that
      // as an idempotent success - the caller wants the mailbox to exist,
      // and it does.
      if (/already exists/i.test(message)) return { created: false };
      throw new HttpException(`cPanel: ${message}`, 502);
    }
    this.logger.log(`cPanel created mailbox ${args.email}`);
    return { created: true };
  }

  /** List every mailbox on the configured domain. Used to discover existing
   *  webmail users that aren't yet in the CRM. */
  async listEmails(): Promise<CpanelEmailAccount[]> {
    if (!this.isEnabled()) return [];
    const result = await this.uapi('Email', 'list_pops_with_disk', {
      domain: this.domain ?? '',
      // Some cPanel builds reject the param entirely; harmless to send.
      no_validate: '1',
    });
    if (result.errors && result.errors.length > 0) {
      throw new HttpException(`cPanel: ${result.errors.join('; ')}`, 502);
    }
    const items = Array.isArray(result.data) ? result.data : [];
    return items
      .map((row) => mapMailboxRow(row, this.domain ?? ''))
      .filter((m): m is CpanelEmailAccount => m != null);
  }

  /** Rotate a mailbox password via `Email::passwd_pop`. Used when an admin
   *  resets a user's CRM password - keeps webmail and CRM in sync. */
  async setPassword(email: string, password: string): Promise<void> {
    if (!this.isEnabled()) return;
    const [localPart, dom] = email.toLowerCase().split('@');
    if (!localPart || !dom || dom !== this.domain?.toLowerCase()) {
      // Not ours - silently skip. External providers (Gmail, Outlook) don't
      // have a webmail-side password to align here.
      return;
    }
    const result = await this.uapi('Email', 'passwd_pop', {
      domain: dom,
      email: localPart,
      password,
    });
    if (result.errors && result.errors.length > 0) {
      throw new HttpException(`cPanel: ${result.errors.join('; ')}`, 502);
    }
    this.logger.log(`cPanel rotated password for ${email}`);
  }

  /** Delete a mailbox via `Email::delete_pop`. Callers should treat this as
   *  optional and reversible only via cPanel restore.
   *  @public Kept deliberately: no caller yet. */
  async deleteEmail(email: string): Promise<void> {
    if (!this.isEnabled()) return;
    const [localPart, dom] = email.toLowerCase().split('@');
    if (!localPart || !dom || dom !== this.domain?.toLowerCase()) return;
    const result = await this.uapi('Email', 'delete_pop', {
      domain: dom,
      email: localPart,
    });
    if (result.errors && result.errors.length > 0) {
      // `does not exist` is idempotent - we wanted it gone, it's gone.
      if (!/does not exist|no such/i.test(result.errors.join(' '))) {
        throw new HttpException(`cPanel: ${result.errors.join('; ')}`, 502);
      }
    }
    this.logger.log(`cPanel deleted mailbox ${email}`);
  }

  /** Low-level UAPI POST. Form-encoded body, token auth header. */
  private async uapi(
    mod: string,
    fn: string,
    params: Record<string, string>,
  ): Promise<UapiResponse> {
    const url = `https://${this.host}:${this.port}/execute/${mod}/${fn}`;
    const body = new URLSearchParams(params).toString();
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `cpanel ${this.user}:${this.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      });
    } catch (err) {
      throw new HttpException(
        `cPanel UAPI request failed: ${(err as Error)?.message ?? 'unknown'}`,
        502,
      );
    }
    if (!res.ok) {
      throw new HttpException(`cPanel UAPI ${mod}/${fn} returned ${res.status}`, 502);
    }
    const json = (await res.json()) as UapiResponse;
    return json;
  }
}

interface UapiResponse {
  status?: number;
  errors?: string[] | null;
  warnings?: string[] | null;
  data?: unknown;
  metadata?: unknown;
}

function mapMailboxRow(raw: unknown, domain: string): CpanelEmailAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const user = String(row['user'] ?? row['login'] ?? '').toLowerCase();
  if (!user) return null;
  // cPanel sometimes returns `email` as "user@domain" and sometimes only the
  // local part - normalize both.
  const rawEmail = String(row['email'] ?? '').toLowerCase();
  const email = rawEmail.includes('@') ? rawEmail : `${user}@${domain}`;
  const quotaMb = Number(row['_diskquota'] ?? row['quota'] ?? 0) || 0;
  const diskUsedBytes = Number(row['_diskused'] ?? row['diskused'] ?? 0) || 0;
  return { email, user, domain, quotaMb, diskUsedBytes };
}
