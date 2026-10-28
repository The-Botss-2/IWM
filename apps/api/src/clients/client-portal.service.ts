import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  clientContactLinkResponseSchema,
  clientContactListSchema,
  clientContactSchema,
  type ClientContact,
  type ClientContactLinkResponse,
  type ClientContactList,
  type InviteClientContactInput,
  type UpdateClientContactInput,
} from '@botss/shared-types';

import { AuditLogService } from '../audit-log/audit-log.service';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { EmailService } from '../email/email.service';
import { agencyBranding } from '../portal/agency';
import { portalAccountReusable } from '../portal/portal-rules';
import {
  newPortalTokenValue,
  PORTAL_TOKEN_TTL_MS,
  portalTokenIdentifier,
  portalTokenIdentifiers,
  portalTokenUrl,
  type PortalTokenKind,
} from '../portal/portal-tokens';
import { RealtimeEventsService } from '../notifications/realtime-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ClientsService } from './clients.service';

const CONTACT_SELECT = {
  id: true,
  clientId: true,
  role: true,
  lastSeenAt: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      // `image` is deliberately not selected: it is client-controlled and
      // would load in staff browsers.
      accounts: { where: { providerId: 'credential' }, select: { id: true }, take: 1 },
    },
  },
  invitedBy: { select: { id: true, name: true } },
} as const;

type ContactRow = {
  id: string;
  clientId: string;
  role: 'PRIMARY' | 'MEMBER';
  lastSeenAt: Date | null;
  createdAt: Date;
  user: { id: string; name: string; email: string; accounts: { id: string }[] };
  invitedBy: { id: string; name: string } | null;
};

interface ManagedClient {
  id: string;
  name: string;
  workspaceId: string;
  organizationId: string;
}

function toClientContact(row: ContactRow): ClientContact {
  return clientContactSchema.parse({
    id: row.id,
    clientId: row.clientId,
    role: row.role,
    status: row.user.accounts.length > 0 ? 'ACTIVE' : 'PENDING',
    user: { id: row.user.id, name: row.user.name, email: row.user.email },
    invitedBy: row.invitedBy,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  });
}

/**
 * Serialise changes to one client's contacts. Under READ COMMITTED two
 * concurrent "make main contact" transactions would each demote before the
 * other commits, leaving two PRIMARY rows. Same lock mode as
 * `lockOpenRequest` in the signatures service; it does not conflict with the
 * key-share lock the ClientContact foreign key takes.
 */
async function lockClientRow(
  tx: { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> },
  clientId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${clientId} FOR NO KEY UPDATE`;
}

function accountElsewhereConflict(): ConflictException {
  return new ConflictException({
    title: 'Email already in use',
    status: 409,
    detail:
      'This email already has a client portal login with another team. Use a different email for this person.',
    code: 'client-portal-account-elsewhere',
  });
}

function expiryLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Staff side of the client portal: who at a client may sign in, and with
 * which role. Viewing the list follows the client's normal visibility;
 * every change needs a workspace owner or admin (or an org admin), the same
 * people who invite workspace members.
 *
 * Portal people are CLIENT accounts with no organization. A person already
 * signed up at another client keeps one account and gains a second contact;
 * a staff email is refused outright - one email is never both.
 */
@Injectable()
export class ClientPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientsService,
    private readonly workspaces: WorkspacesService,
    private readonly email: EmailService,
    private readonly auditLog: AuditLogService,
    private readonly config: ConfigService,
    @Optional() private readonly realtime?: RealtimeEventsService,
  ) {}

  async list(actor: SalesActor, clientId: string): Promise<ClientContactList> {
    // 404 unless this user may see the client at all (assignment rules).
    const client = await this.clients.get(actor, clientId);
    const [rows, canManage] = await Promise.all([
      this.prisma.client.clientContact.findMany({
        where: { clientId, deletedAt: null },
        select: CONTACT_SELECT,
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
      this.workspaces.canAdminister(client.workspaceId, actor.userId),
    ]);
    return clientContactListSchema.parse({ items: rows.map(toClientContact), canManage });
  }

  async invite(
    actor: SalesActor,
    clientId: string,
    input: InviteClientContactInput,
  ): Promise<ClientContactLinkResponse> {
    const client = await this.manageableClient(actor, clientId);
    const email = input.email.trim().toLowerCase();

    // Raw client: a soft-deleted (offboarded) account still owns its email.
    const existing = await this.prisma.raw.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        accountType: true,
        organizationId: true,
        deletedAt: true,
        accounts: { where: { providerId: 'credential' }, select: { id: true }, take: 1 },
      },
    });
    // A staff account of THIS organization gets the specific message (the
    // admin already knows their own team). Any other unusable account gets
    // one generic answer, so the caller cannot learn which kind of account or
    // which organization it belongs to.
    if (
      existing &&
      existing.accountType !== 'CLIENT' &&
      existing.organizationId === client.organizationId
    ) {
      throw new ConflictException({
        title: 'Team member email',
        status: 409,
        detail:
          'This email belongs to a team member account. A client portal login needs its own email.',
        code: 'staff-account',
      });
    }
    if (existing && (existing.accountType !== 'CLIENT' || existing.deletedAt)) {
      throw new ConflictException({
        title: 'Email not available',
        status: 409,
        detail: "This email can't be used for a portal login. Use a different email.",
        code: 'email-unavailable',
      });
    }
    if (existing) {
      await this.assertAccountBelongsHere(
        existing.id,
        existing.accounts.length > 0,
        client.workspaceId,
      );
      const live = await this.prisma.client.clientContact.findFirst({
        where: { clientId, userId: existing.id, deletedAt: null },
        select: { id: true },
      });
      if (live) {
        throw new ConflictException({
          title: 'Already has portal access',
          status: 409,
          detail:
            "This person can already use this client's portal. Resend their invite or send a password reset link instead.",
        });
      }
    }

    const name = (input.name?.trim() || existing?.name || email.split('@')[0] || email).slice(
      0,
      100,
    );
    const contactId = await this.prisma.client.$transaction(async (tx) => {
      await lockClientRow(tx, clientId);
      if (existing) {
        // The ownership check above ran outside this transaction. Lock the
        // account and re-count, so two workspaces inviting the same
        // unclaimed account at once cannot both attach it: the second
        // blocks here until the first commits, then sees its contact.
        // Raw SQL counts revoked contacts too (the soft-delete extension
        // would hide them).
        await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${existing.id} FOR UPDATE`;
        const counts = await tx.$queryRaw<Array<{ elsewhere: number; here: number }>>`
          SELECT
            COUNT(*) FILTER (WHERE c."workspaceId" <> ${client.workspaceId})::int AS elsewhere,
            COUNT(*) FILTER (WHERE c."workspaceId" = ${client.workspaceId})::int AS here
          FROM "ClientContact" cc
          JOIN "Client" c ON c.id = cc."clientId"
          WHERE cc."userId" = ${existing.id}`;
        const { elsewhere = 0, here = 0 } = counts[0] ?? {};
        if (
          !portalAccountReusable({ elsewhere, here, hasPassword: existing.accounts.length > 0 })
        ) {
          throw accountElsewhereConflict();
        }
      }
      const userId =
        existing?.id ??
        (
          await tx.user.create({
            data: {
              email,
              name,
              accountType: 'CLIENT',
              // No organization on purpose: org-scoped user queries (pickers,
              // directories, admin lists) then never see a portal account.
              organizationId: null,
              emailVerified: false,
            },
            select: { id: true },
          })
        ).id;
      if (input.role === 'PRIMARY') {
        await tx.clientContact.updateMany({
          where: { clientId, role: 'PRIMARY', deletedAt: null, userId: { not: userId } },
          data: { role: 'MEMBER' },
        });
      }
      // Upsert, not create: a revoked contact is a soft-deleted row on the
      // same (clientId, userId) key, and re-inviting revives it.
      const contact = await tx.clientContact.upsert({
        where: { clientId_userId: { clientId, userId } },
        create: { clientId, userId, role: input.role, invitedById: actor.userId },
        update: { deletedAt: null, role: input.role, invitedById: actor.userId, lastSeenAt: null },
        select: { id: true },
      });
      return contact.id;
    });

    const hasPassword = (existing?.accounts.length ?? 0) > 0;
    void this.auditLog.emit({
      organizationId: client.organizationId,
      actorUserId: actor.userId,
      action: 'client.portal.invite',
      target: `client:${clientId}`,
      metadata: { contactId, email, role: input.role, existingAccount: !!existing },
    });
    return this.deliver(actor, client, contactId, hasPassword ? 'access' : 'invite');
  }

  /** New invite link for someone who has not set a password yet. */
  async resend(
    actor: SalesActor,
    clientId: string,
    contactId: string,
  ): Promise<ClientContactLinkResponse> {
    const client = await this.manageableClient(actor, clientId);
    const row = await this.liveContact(clientId, contactId);
    if (row.user.accounts.length > 0) {
      throw new ConflictException({
        title: 'Already set up',
        status: 409,
        detail: 'This person has already set a password. Send a password reset link instead.',
      });
    }
    return this.deliver(actor, client, row.id, 'invite');
  }

  /** New-password link for someone who has one already. */
  async sendPasswordReset(
    actor: SalesActor,
    clientId: string,
    contactId: string,
  ): Promise<ClientContactLinkResponse> {
    const client = await this.manageableClient(actor, clientId);
    const row = await this.liveContact(clientId, contactId);
    if (row.user.accounts.length === 0) {
      throw new ConflictException({
        title: 'Not set up yet',
        status: 409,
        detail: 'This person has not accepted their invite yet. Resend the invite instead.',
      });
    }
    void this.auditLog.emit({
      organizationId: client.organizationId,
      actorUserId: actor.userId,
      action: 'client.portal.password_reset',
      target: `client:${clientId}`,
      metadata: { contactId: row.id },
    });
    return this.deliver(actor, client, row.id, 'reset');
  }

  async updateRole(
    actor: SalesActor,
    clientId: string,
    contactId: string,
    input: UpdateClientContactInput,
  ): Promise<ClientContact> {
    const client = await this.manageableClient(actor, clientId);
    const row = await this.liveContact(clientId, contactId);
    await this.prisma.client.$transaction(async (tx) => {
      await lockClientRow(tx, clientId);
      // One main contact per client: promoting someone demotes the current one.
      if (input.role === 'PRIMARY') {
        await tx.clientContact.updateMany({
          where: { clientId, role: 'PRIMARY', deletedAt: null, id: { not: row.id } },
          data: { role: 'MEMBER' },
        });
      }
      await tx.clientContact.update({ where: { id: row.id }, data: { role: input.role } });
    });
    void this.auditLog.emit({
      organizationId: client.organizationId,
      actorUserId: actor.userId,
      action: 'client.portal.role',
      target: `client:${clientId}`,
      metadata: { contactId: row.id, role: input.role },
    });
    return toClientContact(await this.liveContact(clientId, contactId));
  }

  async revoke(actor: SalesActor, clientId: string, contactId: string): Promise<void> {
    const client = await this.manageableClient(actor, clientId);
    const row = await this.liveContact(clientId, contactId);
    const userId = row.user.id;
    let signedOut = false;
    await this.prisma.client.$transaction(async (tx) => {
      // Soft delete by hand: the extension's `delete` does not join a
      // transaction.
      await tx.clientContact.update({ where: { id: row.id }, data: { deletedAt: new Date() } });
      // Outstanding invite and reset links stop working.
      await tx.verificationToken.deleteMany({
        where: { identifier: { in: portalTokenIdentifiers(clientId, userId) } },
      });
      // Personal document shares in this workspace go too, unless the person
      // is still a contact of another client here.
      const stillInWorkspace = await tx.clientContact.count({
        where: {
          userId,
          deletedAt: null,
          client: { workspaceId: client.workspaceId, deletedAt: null },
        },
      });
      if (stillInWorkspace === 0) {
        await tx.documentAccess.deleteMany({
          where: { userId, document: { workspaceId: client.workspaceId } },
        });
      }
      // No portal access left anywhere: sign them out everywhere now.
      const stillAnywhere = await tx.clientContact.count({ where: { userId, deletedAt: null } });
      if (stillAnywhere === 0) {
        await tx.session.deleteMany({ where: { userId } });
        signedOut = true;
      }
    });
    if (signedOut) this.realtime?.publishSessionsRevoked([userId]);
    void this.auditLog.emit({
      organizationId: client.organizationId,
      actorUserId: actor.userId,
      action: 'client.portal.revoke',
      target: `client:${clientId}`,
      metadata: { contactId: row.id, userId },
    });
  }

  // --------------------------------------------------------------------------

  /** The client in the active workspace, if this user may manage its portal. */
  private async manageableClient(actor: SalesActor, clientId: string): Promise<ManagedClient> {
    const client = await this.prisma.client.client.findFirst({
      where: { id: clientId, workspaceId: actor.workspaceId },
      select: {
        id: true,
        name: true,
        workspaceId: true,
        workspace: { select: { organizationId: true } },
      },
    });
    if (!client) {
      throw new NotFoundException({ title: 'Client not found', status: 404 });
    }
    if (!(await this.workspaces.canAdminister(client.workspaceId, actor.userId))) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only workspace owners and admins manage client portal access.',
      });
    }
    return {
      id: client.id,
      name: client.name,
      workspaceId: client.workspaceId,
      organizationId: client.workspace.organizationId,
    };
  }

  /**
   * One portal account belongs to ONE workspace. Its password is
   * account-wide, and the admins of a workspace can mint password links for
   * their own contacts, so letting a second workspace - maybe another
   * tenant, which anyone can create through org signup - attach the same
   * account would let that workspace's admins take it over and read or sign
   * everything the person can reach elsewhere.
   *
   * Refused: an account with any contact row (live or revoked) in another
   * workspace, and an account that already has a password but no history in
   * this workspace (its password was set by someone else).
   */
  private async assertAccountBelongsHere(
    userId: string,
    hasPassword: boolean,
    workspaceId: string,
  ): Promise<void> {
    // Raw client: revoked (soft-deleted) contacts count too.
    const [elsewhere, here] = await Promise.all([
      this.prisma.raw.clientContact.count({
        where: { userId, client: { workspaceId: { not: workspaceId } } },
      }),
      this.prisma.raw.clientContact.count({ where: { userId, client: { workspaceId } } }),
    ]);
    if (!portalAccountReusable({ elsewhere, here, hasPassword })) {
      throw accountElsewhereConflict();
    }
  }

  private async liveContact(clientId: string, contactId: string): Promise<ContactRow> {
    const row = await this.prisma.client.clientContact.findFirst({
      where: { id: contactId, clientId, deletedAt: null },
      select: CONTACT_SELECT,
    });
    if (!row) {
      throw new NotFoundException({ title: 'Portal contact not found', status: 404 });
    }
    return row;
  }

  /**
   * Mint the link (invite and reset only) and email it. The link comes back
   * in the response too, so staff can pass it on by hand when mail is slow
   * or down - the same fallback as workspace invites and signing links.
   */
  private async deliver(
    actor: SalesActor,
    client: ManagedClient,
    contactId: string,
    variant: 'invite' | 'access' | 'reset',
  ): Promise<ClientContactLinkResponse> {
    const row = await this.liveContact(client.id, contactId);
    const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    let link: string | null = null;
    let expiresAt: Date | null = null;
    if (variant !== 'access') {
      const kind: PortalTokenKind = variant === 'invite' ? 'portal-invite' : 'portal-reset';
      ({ link, expiresAt } = await this.issueToken(kind, client.id, row.user.id, appUrl));
    }
    // Defence in depth for the rule in assertAccountBelongsHere: a
    // set-password link comes back to staff only when the account lives
    // entirely in this workspace. Otherwise it goes to the mailbox only.
    const elsewhere = await this.prisma.raw.clientContact.count({
      where: { userId: row.user.id, client: { workspaceId: { not: client.workspaceId } } },
    });
    const [agency, inviter] = await Promise.all([
      agencyBranding(this.prisma, client.organizationId),
      this.prisma.client.user.findUnique({ where: { id: actor.userId }, select: { name: true } }),
    ]);
    const emailed = await this.email.sendClientPortalEmail({
      variant,
      to: row.user.email,
      recipientName: row.user.name,
      agencyName: agency.name,
      clientName: client.name,
      inviterName: inviter?.name ?? null,
      url: link ?? `${appUrl.replace(/\/$/, '')}/portal`,
      expiresAtLabel: expiresAt ? expiryLabel(expiresAt) : null,
      organizationId: client.organizationId,
    });
    const shareLink = elsewhere === 0;
    return clientContactLinkResponseSchema.parse({
      contact: toClientContact(row),
      link: shareLink ? link : null,
      linkExpiresAt: shareLink ? expiresAt : null,
      emailed,
    });
  }

  /** Replace any outstanding link of this kind with a fresh one. */
  private async issueToken(
    kind: PortalTokenKind,
    clientId: string,
    userId: string,
    appUrl: string,
  ): Promise<{ link: string; expiresAt: Date }> {
    const identifier = portalTokenIdentifier(kind, clientId, userId);
    const value = newPortalTokenValue();
    const expiresAt = new Date(Date.now() + PORTAL_TOKEN_TTL_MS[kind]);
    await this.prisma.client.$transaction([
      this.prisma.client.verificationToken.deleteMany({ where: { identifier } }),
      this.prisma.client.verificationToken.create({ data: { identifier, value, expiresAt } }),
    ]);
    return { link: portalTokenUrl(appUrl, value), expiresAt };
  }
}
