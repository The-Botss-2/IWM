import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import type {
  AddMailAccountInput,
  CreateMailSignatureInput,
  MailAccount,
  MailSignature,
  UpdateMailAccountInput,
  UpdateMailSignatureInput,
} from '@botss/shared-types';

import { CpanelService } from '../cpanel/cpanel.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import { PrismaService } from '../prisma/prisma.service';
import { ImapSyncService } from './imap-sync.service';
import { MailCryptoService } from './mail-crypto.service';
import { MAIL_QUEUE, MAIL_VERIFY_JOB_OPTIONS, type MailJobData } from './mail.queue';
import { MailVerifierService } from './mail-verifier.service';

/**
 * MailAccount CRUD + verification orchestration.
 *
 * Ownership: every method enforces `account.userId === ctx.userId`. Workspace
 * admins can list workspace-wide accounts via the dedicated default-lookup
 * helper (for transactional email selection), but cannot read or mutate
 * another user's mail account.
 */
@Injectable()
export class MailAccountsService {
  private readonly logger = new Logger(MailAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: MailCryptoService,
    private readonly verifier: MailVerifierService,
    private readonly cpanel: CpanelService,
    private readonly imapSync: ImapSyncService,
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue<MailJobData>,
  ) {}

  /**
   * Self-serve mailbox setup for users whose email is on the cPanel-managed
   * domain. Resets the webmail password to the user's chosen value and
   * provisions a MailAccount with that same password - IMAP verification
   * can't fail with a stale credential because we just set it. Requires
   * CPANEL_API_TOKEN to be configured; throws otherwise so the UI can show
   * an actionable error.
   */
  async selfSetup(workspaceId: string, userId: string, password: string): Promise<MailAccount> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, organizationId: true },
    });
    if (!user) throw new NotFoundException({ title: 'User not found', status: 404 });
    // The cPanel server is the platform's: only root-org users may re-password
    // a mailbox there, even if a tenant user ends up with an address on that
    // domain.
    if (user.organizationId !== ROOT_ORG_ID) {
      throw new ForbiddenException({
        title: 'Mailbox setup not available',
        status: 403,
        detail:
          "Mailbox setup is only for The Botss team. Add your mailbox manually with your provider's IMAP/SMTP settings.",
        code: 'cpanel-platform-only',
      });
    }
    if (!this.cpanel.isEnabled()) {
      throw new ForbiddenException({
        title: 'cPanel not configured',
        status: 503,
        detail:
          'Self-serve mailbox setup needs CPANEL_API_TOKEN configured on the server. Ask your admin to fill in the cPanel env vars, or add this mailbox manually.',
      });
    }
    if (!this.cpanel.ownsEmail(user.email)) {
      throw new ForbiddenException({
        title: 'Domain not managed by cPanel',
        status: 400,
        detail: `Your email (${user.email}) is not on the cPanel-managed domain. Add the mailbox manually with your provider's IMAP/SMTP credentials.`,
      });
    }
    const imapHost = process.env.MAIL_DEFAULT_IMAP_HOST?.trim();
    const smtpHost = process.env.MAIL_DEFAULT_SMTP_HOST?.trim();
    if (!imapHost || !smtpHost) {
      throw new ForbiddenException({
        title: 'Mail hosts not configured',
        status: 503,
        detail:
          'Self-serve mailbox setup needs MAIL_DEFAULT_IMAP_HOST and MAIL_DEFAULT_SMTP_HOST configured on the server. Ask your admin, or add this mailbox manually.',
      });
    }
    // Reset the cPanel mailbox password FIRST. If that fails, abort before
    // writing any local state - otherwise we'd end up with a MailAccount
    // whose stored password doesn't match the actual mailbox.
    await this.cpanel.setPassword(user.email, password);

    // Drop any existing MailAccount for the same address so `add` doesn't
    // throw with a duplicate-email error.
    const existing = await this.prisma.client.mailAccount.findFirst({
      where: {
        userId,
        email: user.email.toLowerCase(),
        deletedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.client.mailAccount.update({
        where: { id: existing.id },
        data: { deletedAt: new Date(), status: 'DISABLED', isDefault: false },
      });
    }

    return this.add(workspaceId, userId, {
      email: user.email,
      displayName: user.name,
      imapHost,
      imapPort: 993,
      imapSecure: true,
      smtpHost,
      smtpPort: 465,
      smtpSecure: true,
      username: user.email,
      password,
      isDefault: true,
    });
  }

  async list(userId: string): Promise<{ items: MailAccount[] }> {
    const rows = await this.prisma.client.mailAccount.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      include: { signatures: { orderBy: { createdAt: 'asc' } } },
    });
    return { items: rows.map((r) => toDto(r, r.signatures)) };
  }

  async add(workspaceId: string, userId: string, input: AddMailAccountInput): Promise<MailAccount> {
    const existing = await this.prisma.client.mailAccount.findFirst({
      where: { userId, email: input.email.toLowerCase() },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({
        title: 'Account already exists',
        status: 409,
        detail: 'You have already added this mailbox.',
      });
    }

    const ciphertext = this.crypto.encrypt(input.password);

    // If the caller requests default, clear the flag from every other account
    // owned by the same user. A user can only have one default at a time, but
    // multiple users in the workspace can each have their own default.
    const account = await this.prisma.client.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.mailAccount.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      if (existing && existing.deletedAt) {
        // Resurrect a previously soft-deleted account with the same email.
        return tx.mailAccount.update({
          where: { id: existing.id },
          data: {
            workspaceId,
            displayName: input.displayName ?? null,
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            imapSecure: input.imapSecure,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            smtpSecure: input.smtpSecure,
            username: input.username,
            passwordCiphertext: ciphertext,
            status: 'CONNECTING',
            lastError: null,
            isDefault: input.isDefault ?? false,
            deletedAt: null,
          },
        });
      }
      return tx.mailAccount.create({
        data: {
          workspaceId,
          userId,
          email: input.email.toLowerCase(),
          displayName: input.displayName ?? null,
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapSecure: input.imapSecure,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpSecure: input.smtpSecure,
          username: input.username,
          passwordCiphertext: ciphertext,
          status: 'CONNECTING',
          isDefault: input.isDefault ?? false,
        },
      });
    });

    // Schedule verification asynchronously; the UI polls status afterwards.
    await this.queue
      .add(
        'verify-account',
        { kind: 'verify-account', accountId: account.id },
        MAIL_VERIFY_JOB_OPTIONS,
      )
      .catch((err) => {
        this.logger.error(
          `Failed to enqueue verify-account accountId=${account.id} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      });

    return toDto(account);
  }

  async update(
    userId: string,
    accountId: string,
    input: UpdateMailAccountInput,
  ): Promise<MailAccount> {
    const existing = await this.ownedOrThrow(userId, accountId);

    const data: Record<string, unknown> = {};
    for (const k of [
      'displayName',
      'imapHost',
      'imapPort',
      'imapSecure',
      'smtpHost',
      'smtpPort',
      'smtpSecure',
      'username',
    ] as const) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) data[k] = v;
    }
    if (input.password !== undefined) {
      data['passwordCiphertext'] = this.crypto.encrypt(input.password);
      data['status'] = 'CONNECTING';
      data['lastError'] = null;
    }
    if (input.signature !== undefined) {
      // Empty/whitespace-only clears the signature.
      const sig = input.signature?.trim() ? input.signature : null;
      data['signature'] = sig;
    }
    if (input.signatureBeforeQuote !== undefined) {
      data['signatureBeforeQuote'] = input.signatureBeforeQuote;
    }
    // Default-signature pointers must reference a signature owned by THIS
    // account (or be explicitly cleared with null).
    if (input.newSignatureId !== undefined) {
      await this.assertSignatureOwned(accountId, input.newSignatureId);
      data['newSignatureId'] = input.newSignatureId;
    }
    if (input.replySignatureId !== undefined) {
      await this.assertSignatureOwned(accountId, input.replySignatureId);
      data['replySignatureId'] = input.replySignatureId;
    }
    const triggerVerify =
      input.password !== undefined ||
      input.imapHost !== undefined ||
      input.imapPort !== undefined ||
      input.smtpHost !== undefined ||
      input.smtpPort !== undefined ||
      input.username !== undefined;

    await this.prisma.client.$transaction(async (tx) => {
      if (input.isDefault === true) {
        await tx.mailAccount.updateMany({
          where: { userId, isDefault: true, id: { not: accountId } },
          data: { isDefault: false },
        });
        data['isDefault'] = true;
      } else if (input.isDefault === false) {
        data['isDefault'] = false;
      }
      await tx.mailAccount.update({ where: { id: accountId }, data });
    });

    if (triggerVerify) {
      // Drop the pooled connection (if any) - it's holding the OLD
      // credentials and will keep failing until it's recycled. Eviction
      // ensures the next sync opens a fresh login with the new creds.
      this.imapSync.evictPooledClient(accountId);
      await this.queue
        .add('verify-account', { kind: 'verify-account', accountId }, MAIL_VERIFY_JOB_OPTIONS)
        .catch((err) =>
          this.logger.error(
            `Failed to enqueue verify-account accountId=${accountId} message=${(err as Error)?.message ?? 'unknown'}`,
          ),
        );
    }

    return this.loadAccountDto(existing.id);
  }

  // --------------------------------------------------------------------------
  // Signatures - multiple named sign-offs per account, with separate defaults
  // for new mail vs replies (set via `update` above). Every method enforces
  // account ownership through `ownedOrThrow`.
  // --------------------------------------------------------------------------

  async addSignature(
    userId: string,
    accountId: string,
    input: CreateMailSignatureInput,
  ): Promise<MailAccount> {
    await this.ownedOrThrow(userId, accountId);
    await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.mailSignature.create({
        data: { accountId, name: input.name, html: input.html },
        select: { id: true },
      });
      // First signature on an account with no defaults yet: adopt it for both
      // new mail and replies so the user gets a sensible default immediately.
      const account = await tx.mailAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { newSignatureId: true, replySignatureId: true },
      });
      const data: { newSignatureId?: string; replySignatureId?: string } = {};
      if (!account.newSignatureId) data.newSignatureId = created.id;
      if (!account.replySignatureId) data.replySignatureId = created.id;
      if (data.newSignatureId || data.replySignatureId) {
        await tx.mailAccount.update({ where: { id: accountId }, data });
      }
    });
    return this.loadAccountDto(accountId);
  }

  async updateSignature(
    userId: string,
    accountId: string,
    signatureId: string,
    input: UpdateMailSignatureInput,
  ): Promise<MailAccount> {
    await this.ownedOrThrow(userId, accountId);
    await this.assertSignatureOwned(accountId, signatureId);
    const data: { name?: string; html?: string } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.html !== undefined) data.html = input.html;
    await this.prisma.client.mailSignature.update({
      where: { id: signatureId },
      data,
    });
    return this.loadAccountDto(accountId);
  }

  async removeSignature(
    userId: string,
    accountId: string,
    signatureId: string,
  ): Promise<MailAccount> {
    await this.ownedOrThrow(userId, accountId);
    await this.assertSignatureOwned(accountId, signatureId);
    // The new/reply default FKs are ON DELETE SET NULL, so deleting a
    // signature that's currently a default simply clears that default.
    await this.prisma.client.mailSignature.delete({ where: { id: signatureId } });
    return this.loadAccountDto(accountId);
  }

  /** Load an account with its signatures and return the client DTO. */
  private async loadAccountDto(accountId: string): Promise<MailAccount> {
    const row = await this.prisma.client.mailAccount.findUniqueOrThrow({
      where: { id: accountId },
      include: { signatures: { orderBy: { createdAt: 'asc' } } },
    });
    return toDto(row, row.signatures);
  }

  /**
   * Guard for default-signature pointers and signature mutations: a null id is
   * always allowed (clears the default); a non-null id must reference a
   * signature row owned by `accountId`.
   */
  private async assertSignatureOwned(accountId: string, signatureId: string | null): Promise<void> {
    if (signatureId == null) return;
    const sig = await this.prisma.client.mailSignature.findUnique({
      where: { id: signatureId },
      select: { accountId: true },
    });
    if (!sig || sig.accountId !== accountId) {
      throw new NotFoundException({
        title: 'Signature not found',
        status: 404,
        detail: 'That signature does not belong to this mail account.',
      });
    }
  }

  /** Run verification inline and return the result. */
  async test(userId: string, accountId: string) {
    const account = await this.ownedOrThrow(userId, accountId);
    const password = this.crypto.decrypt(account.passwordCiphertext);
    const result = await this.verifier.verify({
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecure: account.imapSecure,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecure: account.smtpSecure,
      username: account.username,
      password,
    });
    await this.prisma.client.mailAccount.update({
      where: { id: accountId },
      data: {
        status: result.status,
        lastError: result.error,
        lastSyncedAt: result.status === 'ACTIVE' ? new Date() : account.lastSyncedAt,
      },
    });
    return {
      ok: result.status === 'ACTIVE',
      status: result.status,
      error: result.error,
      imapOk: result.imapOk,
      smtpOk: result.smtpOk,
    };
  }

  async remove(userId: string, accountId: string): Promise<void> {
    await this.ownedOrThrow(userId, accountId);
    // Soft delete - keeps historical messages reachable for audit purposes.
    await this.prisma.client.mailAccount.update({
      where: { id: accountId },
      data: { deletedAt: new Date(), status: 'DISABLED', isDefault: false },
    });
    // Drop the pooled IMAP connection so we don't keep talking to the
    // server about an account the user removed.
    this.imapSync.evictPooledClient(accountId);
  }

  private async ownedOrThrow(userId: string, accountId: string) {
    const account = await this.prisma.client.mailAccount.findUnique({
      where: { id: accountId },
    });
    if (!account || account.deletedAt) {
      throw new NotFoundException({ title: 'Mail account not found', status: 404 });
    }
    if (account.userId !== userId) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You do not own this mail account.',
      });
    }
    return account;
  }
}

type MailAccountRow = {
  id: string;
  workspaceId: string;
  userId: string;
  email: string;
  displayName: string | null;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  username: string;
  signature: string | null;
  newSignatureId: string | null;
  replySignatureId: string | null;
  signatureBeforeQuote: boolean;
  status: 'CONNECTING' | 'ACTIVE' | 'AUTH_FAILED' | 'CONNECTION_FAILED' | 'DISABLED';
  lastError: string | null;
  lastSyncedAt: Date | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type MailSignatureRow = {
  id: string;
  accountId: string;
  name: string;
  html: string;
  createdAt: Date;
  updatedAt: Date;
};

function signatureToDto(row: MailSignatureRow): MailSignature {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    html: row.html,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Strip the ciphertext + raw cursor before serialising to the client. */
function toDto(row: MailAccountRow, signatures: MailSignatureRow[] = []): MailAccount {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    username: row.username,
    signature: row.signature,
    signatures: signatures.map(signatureToDto),
    newSignatureId: row.newSignatureId,
    replySignatureId: row.replySignatureId,
    signatureBeforeQuote: row.signatureBeforeQuote,
    status: row.status,
    lastError: row.lastError,
    lastSyncedAt: row.lastSyncedAt,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
