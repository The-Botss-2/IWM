import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { hashPassword } from '@botss/auth';
import type {
  AdminCreateUserInput,
  AdminImportWebmailUserInput,
  AdminUpdateUserInput,
  WebmailCandidate,
} from '@botss/shared-types';

import { assertMayAdministerUser, assertSameOrg } from './admin-user-policy';
import { SessionsService } from '../sessions/sessions.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SecurityAlertsService } from '../security-alerts/security-alerts.service';
import { CpanelService } from '../cpanel/cpanel.service';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import { assertNotClientAccount } from '../common/client-accounts';
import { assertEmailDomainAllowed } from '../common/email-domain';
import { MailAccountsService } from '../mail/mail-accounts.service';
import { RealtimeEventsService } from '../notifications/realtime-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { userHasCompanyPermission } from '../common/permissions/effective-permissions';
import { isSupportRequest } from '../common/request-context';
import { supportNotAllowed } from '../support/support-rules';

/**
 * "Is this email managed by our cPanel server?" - used to decide whether
 * the auto-mail-provision and password-sync flows should run. Delegates to
 * `CpanelService.ownsEmail`, which reads `CPANEL_DOMAIN` from env.
 */
/**
 * IMAP/SMTP hosts for auto-provisioned mail accounts, from
 * MAIL_DEFAULT_IMAP_HOST / MAIL_DEFAULT_SMTP_HOST. Null (no auto-provisioning)
 * unless both are set.
 */
function defaultMailHosts(): { imapHost: string; smtpHost: string } | null {
  const imapHost = process.env.MAIL_DEFAULT_IMAP_HOST?.trim();
  const smtpHost = process.env.MAIL_DEFAULT_SMTP_HOST?.trim();
  return imapHost && smtpHost ? { imapHost, smtpHost } : null;
}

/**
 * The protected primary admin address from ADMIN_EMAIL (lower-cased), or null
 * when unset: then no account is protected from demotion or deletion.
 */
function primaryAdminEmail(): string | null {
  return process.env.ADMIN_EMAIL?.trim().toLowerCase() || null;
}

function emailIsLocalToCpanel(cpanel: CpanelService, email: string): boolean {
  return cpanel.ownsEmail(email);
}

/**
 * Admin-only user management. The Botss CRM is closed: new accounts come
 * exclusively from this service. For users on the cPanel-managed domain
 * (set via CPANEL_DOMAIN) the create path also provisions a MailAccount
 * pre-configured for the cPanel mail server, so the user can read mail
 * immediately on first login with zero setup.
 */
@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailAccounts: MailAccountsService,
    private readonly cpanel: CpanelService,
    private readonly auditLog: AuditLogService,
    private readonly sessions: SessionsService,
    @Optional() private readonly realtime?: RealtimeEventsService,
    @Optional() private readonly alerts?: SecurityAlertsService,
  ) {}

  /**
   * Throws 403 unless the acting user holds an admin tier (ADMIN or
   * SUPER_ADMIN). Single chokepoint so we can't accidentally expose an
   * admin endpoint behind a different guard. SUPER_ADMIN is the
   * platform operator; ADMIN is tenant-scoped. Both have admin-tier
   * powers inside their own org.
   */
  async assertAdmin(actingUserId: string): Promise<void> {
    // Company `users.manage` (ADMIN / SUPER_ADMIN presets, or a custom role).
    if (!(await userHasCompanyPermission(actingUserId, 'users.manage'))) {
      throw new ForbiddenException({
        title: 'Admin only',
        status: 403,
        detail: 'This action requires system admin privileges.',
      });
    }
  }

  /**
   * Throws 403 unless the acting user is ADMIN, SUPER_ADMIN, or HR.
   * Used as the chokepoint for the Attendance + Leave administrative
   * endpoints (cross-user reads, status mutations, manual overrides).
   */
  async assertAdminOrHR(actingUserId: string): Promise<void> {
    // `users.manage` or either HR permission (ADMIN / SUPER_ADMIN / HR presets).
    if (
      !(await userHasCompanyPermission(
        actingUserId,
        'users.manage',
        'hr.attendance',
        'hr.leave.approve',
      ))
    ) {
      throw new ForbiddenException({
        title: 'Admin or HR only',
        status: 403,
        detail: 'This action requires system admin or HR privileges.',
      });
    }
  }

  /**
   * cPanel is the platform's own mail server. Only an actor in the platform
   * (root) organization, or a SUPER_ADMIN, may touch it; a tenant admin must
   * never create, re-password or list mailboxes there.
   */
  async actorIsPlatform(actingUserId: string): Promise<boolean> {
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organization: { select: { isRoot: true } } },
    });
    return actor?.systemRole === 'SUPER_ADMIN' || actor?.organization?.isRoot === true;
  }

  /**
   * Reject the cPanel domain and any domain another organization claims,
   * unless `orgId` is the platform (root) organization.
   */
  async assertEmailDomainAllowed(orgId: string | null, email: string): Promise<void> {
    const org = orgId
      ? await this.prisma.client.organization.findUnique({
          where: { id: orgId },
          select: { isRoot: true },
        })
      : null;
    await assertEmailDomainAllowed({
      orgId,
      actorOrgIsRoot: org?.isRoot === true,
      email,
      claimingOrgId: async (domain) => {
        const claim = await this.prisma.client.organization.findFirst({
          where: { emailDomain: domain, deletedAt: null },
          select: { id: true },
        });
        return claim?.id ?? null;
      },
    });
  }

  /**
   * Global admin = `systemRole === 'SUPER_ADMIN'`. The Postgres trigger
   * `trg_super_admin_root_only` guarantees those users live in the root
   * org, so we no longer need to assert the org here. Gates platform
   * operations only: organization management and the platform log. It
   * never grants access to data inside another organization.
   *
   * A tenant-org `ADMIN` is intentionally NOT a global admin — they're
   * a tenant-scoped admin only.
   */
  async assertGlobalAdmin(actingUserId: string): Promise<void> {
    // The operator's own row says SUPER_ADMIN, but inside a support session
    // they act as a read only viewer of another organization.
    if (isSupportRequest()) throw supportNotAllowed();
    const user = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true },
    });
    if (!user || user.systemRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException({
        title: 'Super admin only',
        status: 403,
        detail:
          'This action requires SUPER_ADMIN privileges (Botss platform operator).',
      });
    }
  }

  async list(actingUserId: string, search?: string) {
    await this.assertAdminOrHR(actingUserId);
    // Tenant boundary: everyone, SUPER_ADMIN included, sees only the users
    // of their own organization.
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { organizationId: true },
    });
    const where = {
      organizationId: actor?.organizationId ?? '__none__',
      // Client-portal people are managed from the client's Portal tab.
      accountType: 'STAFF' as const,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { email: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const items = await this.prisma.client.user.findMany({
      where,
      orderBy: [{ systemRole: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        systemRole: true,
        timesheetExempt: true,
        customRoleId: true,
        createdAt: true,
      },
    });
    return { items };
  }

  async create(
    actingUserId: string,
    actingWorkspaceId: string | null,
    input: AdminCreateUserInput,
  ) {
    await this.assertAdminOrHR(actingUserId);
    // Tenant boundary: every admin, SUPER_ADMIN included, can only mint
    // users INSIDE their own org and attach them to workspaces in their own
    // org. Without this, an ADMIN in Org A could create a user pinned to
    // Org B — or grant SUPER_ADMIN — escalating privileges across the
    // platform.
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organizationId: true },
    });
    const isGlobalAdmin = actor?.systemRole === 'SUPER_ADMIN';
    const isAdminTier = isGlobalAdmin || actor?.systemRole === 'ADMIN';
    // HR may create users but ONLY non-admin accounts. Without this an HR
    // user could mint an ADMIN (or SUPER_ADMIN) and self-escalate. ADMIN tier
    // keeps the full grant range, still bounded by the SUPER_ADMIN checks below.
    if (
      !isAdminTier &&
      (input.systemRole === 'ADMIN' || input.systemRole === 'SUPER_ADMIN')
    ) {
      throw new ForbiddenException({
        title: 'HR cannot grant admin roles',
        status: 403,
        detail:
          'HR may create Employee, Project manager, or HR accounts. Admin and Super admin accounts need an admin to create them.',
      });
    }
    const targetOrgId = actor?.organizationId ?? null;
    if (!targetOrgId) {
      throw new ForbiddenException({
        title: 'Cannot determine your organization',
        status: 403,
      });
    }
    if (input.workspaceId) {
      const ws = await this.prisma.client.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { organizationId: true },
      });
      if (!ws) {
        throw new NotFoundException({ title: 'Workspace not found', status: 404 });
      }
      if (ws.organizationId !== targetOrgId) {
        throw new ForbiddenException({
          title: 'Workspace is outside your organization',
          status: 403,
        });
      }
    }
    // SUPER_ADMIN may only be granted by another SUPER_ADMIN, AND the
    // target must end up in the root org (the Postgres trigger enforces
    // this at the DB layer too, but we reject early with a friendlier
    // message). Tenant ADMINs still cannot grant ADMIN to anyone outside
    // their own org — that's covered by the targetOrgId clamp above.
    if (input.systemRole === 'SUPER_ADMIN') {
      if (!isGlobalAdmin) {
        throw new ForbiddenException({
          title: 'Only a SUPER_ADMIN can grant SUPER_ADMIN',
          status: 403,
        });
      }
      if (targetOrgId !== ROOT_ORG_ID) {
        throw new ForbiddenException({
          title: 'SUPER_ADMIN may only exist in the Botss root organization',
          status: 403,
        });
      }
    }
    // A tenant ADMIN may create other ADMINs inside their own org (the
    // `targetOrgId` clamp above forces the new user into the actor's org).
    // Only SUPER_ADMIN remains gated, handled by the block above.

    const email = input.email.toLowerCase().trim();
    await this.assertEmailDomainAllowed(targetOrgId, email);
    const platformActor = await this.actorIsPlatform(actingUserId);
    const existing = await this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        title: 'User already exists',
        status: 409,
        detail: `A user with email ${email} already exists. Edit the existing record instead.`,
      });
    }

    // Provision the cPanel mailbox FIRST so we can fail fast before any CRM
    // state is written. If cPanel returns `{ created: false }` the mailbox
    // already exists on the server - the admin probably meant to import an
    // existing webmail user instead, so we tell them to use that path. If
    // the cPanel client isn't enabled (no env config) this no-ops and we
    // continue without the cPanel side effect - useful in dev.
    if (this.cpanel.ownsEmail(email) && !platformActor) {
      // Belt and braces: the domain rule above already refuses this.
      throw new ForbiddenException({
        title: 'Mailbox domain not allowed',
        status: 403,
        code: 'cpanel-platform-only',
      });
    }
    if (platformActor && this.cpanel.isEnabled() && this.cpanel.ownsEmail(email)) {
      const cp = await this.cpanel.createEmail({
        email,
        password: input.password,
      });
      if (!cp.created) {
        throw new ConflictException({
          title: 'Mailbox already exists on cPanel',
          status: 409,
          detail:
            'A webmail mailbox with this address already exists. Use "Import existing webmail user" to attach it to a CRM account.',
        });
      }
    }

    const passwordHash = hashPassword(input.password);

    const user = await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: input.name,
          // Admin-created accounts are pre-verified - the admin vouches for
          // the address. Skips the verification-email step entirely.
          emailVerified: true,
          systemRole: input.systemRole ?? 'EMPLOYEE',
          // Pin the org explicitly so the auto-route domain match cannot
          // place the user in a different tenant than the admin intended.
          organizationId: targetOrgId,
        },
      });
      await tx.account.create({
        data: {
          userId: created.id,
          providerId: 'credential',
          accountId: created.id,
          password: passwordHash,
        },
      });
      if (input.workspaceId) {
        await tx.workspaceMembership.create({
          data: {
            workspaceId: input.workspaceId,
            userId: created.id,
            role: input.workspaceRole ?? 'MEMBER',
            invitedById: actingUserId,
          },
        });
      }
      return created;
    });

    // If the email is on a domain we manage via cPanel, the password set
    // here is also the webmail password - provision a MailAccount with the
    // configured defaults so the user can read mail immediately on first
    // login. We pick the workspace from `input.workspaceId` if the admin
    // form supplied one (rare - the basic create dialog doesn't); otherwise
    // we fall back to the admin's own current workspace, which is what
    // happens almost every time in practice. Failure here is logged but
    // not fatal: the admin can still retry from the Mail accounts settings.
    const autoMailWorkspaceId = input.workspaceId ?? actingWorkspaceId;
    const localToCpanel = platformActor && emailIsLocalToCpanel(this.cpanel, email);
    if (!localToCpanel) {
      this.logger.log(
        `Auto-MailAccount skip ${email}: not on CPANEL_DOMAIN (${process.env.CPANEL_DOMAIN ?? 'unset'}).`,
      );
    } else if (!autoMailWorkspaceId) {
      this.logger.warn(
        `Auto-MailAccount skip ${email}: no workspaceId resolved for the acting admin. The user has no mailbox and will see "Set up my mailbox" on first login.`,
      );
    }
    const mailHosts = defaultMailHosts();
    if (localToCpanel && autoMailWorkspaceId && !mailHosts) {
      this.logger.log(
        `Auto-MailAccount skip ${email}: MAIL_DEFAULT_IMAP_HOST / MAIL_DEFAULT_SMTP_HOST not set.`,
      );
    }
    if (localToCpanel && autoMailWorkspaceId && mailHosts) {
      try {
        await this.mailAccounts.add(autoMailWorkspaceId, user.id, {
          email,
          displayName: input.name,
          imapHost: mailHosts.imapHost,
          imapPort: 993,
          imapSecure: true,
          smtpHost: mailHosts.smtpHost,
          smtpPort: 465,
          smtpSecure: true,
          username: email,
          password: input.password,
          isDefault: true,
        });
        this.logger.log(
          `Auto-provisioned MailAccount for admin-created user ${email} workspaceId=${autoMailWorkspaceId}`,
        );
      } catch (err) {
        this.logger.warn(
          `Auto-MailAccount FAILED for ${email} workspaceId=${autoMailWorkspaceId} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    this.logger.log(
      `Admin ${actingUserId} created user ${user.id} email=${email} role=${input.systemRole ?? 'EMPLOYEE'}`,
    );
    void this.auditLog.emit({
      organizationId: targetOrgId,
      actorUserId: actingUserId,
      action: 'user.create',
      target: `user:${user.id}`,
      metadata: { email, role: input.systemRole ?? 'EMPLOYEE' },
    });
    this.alertNewAdmin(targetOrgId, actingUserId, user.id, input);
    return this.publicUser(user.id);
  }

  /**
   * A freshly created or imported user who starts with an admin level role
   * (system ADMIN/SUPER_ADMIN, or workspace ADMIN/OWNER) raises a security
   * alert. Fire-and-forget, like the audit row it follows.
   */
  private alertNewAdmin(
    organizationId: string,
    actingUserId: string,
    userId: string,
    input: {
      systemRole?: string | null;
      workspaceId?: string | null;
      workspaceRole?: string | null;
    },
  ): void {
    if (input.systemRole === 'ADMIN' || input.systemRole === 'SUPER_ADMIN') {
      void this.alerts?.recordNewAdmin({
        organizationId,
        actorUserId: actingUserId,
        userId,
        scope: 'system',
        role: input.systemRole,
      });
    }
    if (input.workspaceId && (input.workspaceRole === 'ADMIN' || input.workspaceRole === 'OWNER')) {
      void this.alerts?.recordNewAdmin({
        organizationId,
        actorUserId: actingUserId,
        userId,
        scope: 'workspace',
        role: input.workspaceRole,
      });
    }
  }

  async update(
    actingUserId: string,
    targetUserId: string,
    input: AdminUpdateUserInput,
  ) {
    await this.assertAdmin(actingUserId);
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException({ title: 'User not found', status: 404 });
    }
    assertNotClientAccount(target.accountType);
    // Tenant boundary: every admin, SUPER_ADMIN included, may only edit
    // (and reset the password of) users inside their own org. Granting
    // SUPER_ADMIN requires the actor be a SUPER_ADMIN AND the target be in
    // the root org (the Postgres trigger backstops the org rule).
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organizationId: true },
    });
    assertSameOrg(actor?.organizationId, target.organizationId);
    if (input.systemRole === 'SUPER_ADMIN' && actor?.systemRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException({
        title: 'Only a SUPER_ADMIN can grant SUPER_ADMIN',
        status: 403,
      });
    }
    if (input.systemRole === 'SUPER_ADMIN' && target.organizationId !== ROOT_ORG_ID) {
      throw new ForbiddenException({
        title: 'SUPER_ADMIN may only be granted to users in the Botss root organization',
        status: 403,
      });
    }
    // Tier rules: no editing / password reset of a higher-privileged account,
    // no changing your own role, and role changes need roles.manage.
    assertMayAdministerUser({
      actorId: actingUserId,
      actorRole: actor?.systemRole,
      targetId: targetUserId,
      targetRole: target.systemRole,
      newRole: input.systemRole,
      actorHasRolesManage:
        input.systemRole !== undefined && input.systemRole !== target.systemRole
          ? await userHasCompanyPermission(actingUserId, 'roles.manage')
          : false,
    });
    // Block role demotion of the canonical admin so a misclick can't lock
    // the team out of the admin panel. The canonical address comes from
    // ADMIN_EMAIL; when unset no account is protected. Promoting them to
    // SUPER_ADMIN is fine (they're still privileged); only block demotion
    // to a non-admin tier.
    const adminEmail = primaryAdminEmail();
    if (
      adminEmail &&
      target.email.toLowerCase() === adminEmail &&
      input.systemRole &&
      input.systemRole !== 'ADMIN' &&
      input.systemRole !== 'SUPER_ADMIN'
    ) {
      throw new ForbiddenException({
        title: 'Cannot demote the primary admin',
        status: 403,
        detail: 'The canonical admin account must remain ADMIN or SUPER_ADMIN.',
      });
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.systemRole !== undefined) data['systemRole'] = input.systemRole;
    if (input.phone !== undefined) data['phone'] = input.phone;
    if (input.timesheetExempt !== undefined) {
      data['timesheetExempt'] = input.timesheetExempt;
    }

    // If we're demoting (or promoting) the user's role, drop their existing
    // sessions so the new role takes effect immediately. Without this the
    // user keeps acting with their cached cookie until natural expiry - a
    // demoted admin would retain admin-equivalent capability for up to the
    // session TTL.
    const roleChanging =
      input.systemRole !== undefined && input.systemRole !== target.systemRole;

    await this.prisma.client.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: targetUserId }, data });
      }
      if (input.password) {
        const passwordHash = hashPassword(input.password);
        const existing = await tx.account.findFirst({
          where: { userId: targetUserId, providerId: 'credential' },
          select: { id: true },
        });
        if (existing) {
          await tx.account.update({
            where: { id: existing.id },
            data: { password: passwordHash },
          });
        } else {
          await tx.account.create({
            data: {
              userId: targetUserId,
              providerId: 'credential',
              accountId: targetUserId,
              password: passwordHash,
            },
          });
        }
      }
      // Drop sessions when role or credentials change so the new state is
      // authoritative immediately. We do this once at the end of the tx so a
      // simultaneous role+password change only clears sessions a single time.
      if (roleChanging || input.password) {
        await tx.session.deleteMany({ where: { userId: targetUserId } });
      }
    });
    // Open sockets were authenticated by the sessions just deleted.
    if (roleChanging || input.password) this.realtime?.publishSessionsRevoked([targetUserId]);

    // Keep webmail + MailAccount creds in sync when an admin rotates the
    // password on a user whose domain we manage via cPanel. Otherwise the
    // CRM would accept the new password but the Mail tab and actual webmail
    // would silently fail with the old one.
    if (
      input.password &&
      emailIsLocalToCpanel(this.cpanel, target.email) &&
      (await this.actorIsPlatform(actingUserId))
    ) {
      // 1. cPanel mailbox password - the source of truth for webmail auth.
      if (this.cpanel.isEnabled() && this.cpanel.ownsEmail(target.email)) {
        try {
          await this.cpanel.setPassword(target.email, input.password);
        } catch (err) {
          this.logger.warn(
            `cPanel password rotation failed for ${target.email} message=${(err as Error)?.message ?? 'unknown'}`,
          );
        }
      }
      // 2. Local MailAccount ciphertext - what ImapFlow uses to sync the
      //    inbox. Needs to match what cPanel now stores.
      try {
        const mailAccount = await this.prisma.client.mailAccount.findFirst({
          where: { userId: targetUserId, email: target.email.toLowerCase() },
        });
        if (mailAccount) {
          await this.mailAccounts.update(targetUserId, mailAccount.id, {
            password: input.password,
          });
          this.logger.log(`Synced MailAccount password for ${target.email}`);
        }
      } catch (err) {
        this.logger.warn(
          `Password sync to MailAccount failed userId=${targetUserId} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    // Names of changed fields only: never the password, and no PII values.
    const changedFields = Object.keys(data).filter((f) => f !== 'systemRole');
    if (roleChanging) {
      void this.auditLog.emit({
        organizationId: actor.organizationId,
        actorUserId: actingUserId,
        action: 'user.role_change',
        target: `user:${targetUserId}`,
        metadata: { from: target.systemRole, to: input.systemRole },
      });
      if (input.systemRole === 'ADMIN' || input.systemRole === 'SUPER_ADMIN') {
        void this.alerts?.recordNewAdmin({
          organizationId: actor.organizationId,
          actorUserId: actingUserId,
          userId: targetUserId,
          scope: 'system',
          role: input.systemRole,
        });
      }
    }
    if (changedFields.length > 0 || input.password) {
      void this.auditLog.emit({
        organizationId: actor.organizationId,
        actorUserId: actingUserId,
        action: 'user.update',
        target: `user:${targetUserId}`,
        metadata: { fields: changedFields, passwordReset: !!input.password },
      });
    }

    return this.publicUser(targetUserId);
  }

  /**
   * "Sign out everywhere": delete every session of a user in the admin's OWN
   * organization (strictly: SUPER_ADMIN gets no cross-org reach here), close
   * their realtime sockets and audit it as `user.sessions_revoked`.
   */
  async revokeUserSessions(actingUserId: string, targetUserId: string): Promise<number> {
    await this.assertAdmin(actingUserId);
    if (actingUserId === targetUserId) {
      throw new ForbiddenException({
        title: 'Use the Devices page',
        status: 403,
        detail: 'Sign yourself out of other devices from Settings, Devices.',
      });
    }
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { organizationId: true, accountType: true, systemRole: true },
    });
    if (!target) {
      throw new NotFoundException({ title: 'User not found', status: 404 });
    }
    assertNotClientAccount(target.accountType);
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organizationId: true },
    });
    assertSameOrg(actor?.organizationId, target.organizationId);
    assertMayAdministerUser({
      actorId: actingUserId,
      actorRole: actor?.systemRole,
      targetId: targetUserId,
      targetRole: target.systemRole,
      actorHasRolesManage: false,
    });
    const revoked = await this.sessions.revokeAllFor(targetUserId);
    this.realtime?.publishSessionsRevoked([targetUserId]);
    await this.auditLog.emit({
      organizationId: target.organizationId as string,
      actorUserId: actingUserId,
      action: 'user.sessions_revoked',
      target: `user:${targetUserId}`,
      metadata: { revoked },
    });
    return revoked;
  }

  async remove(actingUserId: string, targetUserId: string): Promise<void> {
    await this.assertAdmin(actingUserId);
    if (actingUserId === targetUserId) {
      throw new ForbiddenException({
        title: 'Cannot delete yourself',
        status: 403,
        detail: 'Ask another admin to remove your account.',
      });
    }
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: {
        email: true,
        name: true,
        organizationId: true,
        accountType: true,
        systemRole: true,
      },
    });
    if (!target) {
      throw new NotFoundException({ title: 'User not found', status: 404 });
    }
    assertNotClientAccount(target.accountType);
    // Tenant boundary: every admin, SUPER_ADMIN included, may only delete
    // users inside their own org.
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true, organizationId: true },
    });
    assertSameOrg(actor?.organizationId, target.organizationId);
    // Removing an account is the strongest edit: same tier rule.
    assertMayAdministerUser({
      actorId: actingUserId,
      actorRole: actor?.systemRole,
      targetId: targetUserId,
      targetRole: target.systemRole,
      actorHasRolesManage: false,
    });
    const adminEmail = primaryAdminEmail();
    if (adminEmail && target.email.toLowerCase() === adminEmail) {
      throw new ForbiddenException({
        title: 'Cannot delete the primary admin',
        status: 403,
        detail: 'The canonical admin account is protected.',
      });
    }
    // Hard-delete via the raw client (bypasses the soft-delete extension
    // which would otherwise convert this into an UPDATE setting
    // `deletedAt`). The User table is in the soft-delete model list but
    // the admin "Remove" action is meant to actually remove the row from
    // the DB - operators expect "Delete" to mean delete.
    //
    // Several user FK references are NOT NULL with onDelete defaulting to
    // RESTRICT, so the row must be reassigned to the acting admin before the
    // hard delete or Postgres raises "Foreign key constraint failed". These
    // are records that belong to the ORG, not the person (projects, invoices,
    // files, documents, goals, holidays) - reassigning preserves them under
    // the admin's name. Keep this list in sync with the schema: every
    // `User`-typed (non-optional) relation WITHOUT onDelete: Cascade/SetNull
    // must appear here. The cascade relations (Session, Account,
    // WorkspaceMembership, ProjectMembership, Attendance, Leave, TimeEntry,
    // Todo, MailAccount, Notification, DocumentAccess-as-grantee,
    // ChatRoomMessage, etc.) take care of themselves.
    await this.prisma.raw.$transaction(async (tx) => {
      const transferTo = actingUserId;
      const reassign = (field: string) => ({
        where: { [field]: targetUserId },
        data: { [field]: transferTo },
      });
      const matchUser = reassign('ownerId');
      const matchByCreator = reassign('createdById');
      const matchByAuthor = reassign('authorId');
      // Ownership-style FKs (ownerId, NOT NULL).
      await tx.workspace.updateMany(matchUser).catch(() => undefined);
      await tx.goal.updateMany(matchUser).catch(() => undefined);
      // Created-by FKs (createdById, NOT NULL).
      await tx.project.updateMany(matchByCreator).catch(() => undefined);
      await tx.task.updateMany(matchByCreator).catch(() => undefined);
      await tx.lead.updateMany(matchByCreator).catch(() => undefined);
      await tx.client.updateMany(matchByCreator).catch(() => undefined);
      await tx.document.updateMany(matchByCreator).catch(() => undefined);
      await tx.documentTemplate.updateMany(matchByCreator).catch(() => undefined);
      await tx.taskForm.updateMany(matchByCreator).catch(() => undefined);
      await tx.savedView.updateMany(matchByCreator).catch(() => undefined);
      await tx.invoice.updateMany(matchByCreator).catch(() => undefined);
      await tx.holiday.updateMany(matchByCreator).catch(() => undefined);
      // Author FKs (authorId, NOT NULL).
      await tx.comment.updateMany(matchByAuthor).catch(() => undefined);
      await tx.goalUpdate.updateMany(matchByAuthor).catch(() => undefined);
      // Remaining required FKs with model-specific field names.
      await tx.documentAccess.updateMany(reassign('grantedById')).catch(() => undefined);
      await tx.documentRevision.updateMany(reassign('changedById')).catch(() => undefined);
      await tx.fileObject.updateMany(reassign('uploadedById')).catch(() => undefined);
      await tx.sprintTask.updateMany(reassign('addedById')).catch(() => undefined);
      await tx.mailOutbox.updateMany(reassign('userId')).catch(() => undefined);
      await tx.payment.updateMany(reassign('recordedById')).catch(() => undefined);
      // Payroll. The person's own roster row cascades with them (their past
      // payslips keep a name snapshot); what they set up for others stays.
      await tx.expense.updateMany(reassign('recordedById')).catch(() => undefined);
      await tx.payrollEmployee.updateMany(matchByCreator).catch(() => undefined);
      await tx.payrollRun.updateMany(matchByCreator).catch(() => undefined);

      // Sessions and accounts are also Cascade-friendly but explicit
      // deletion keeps the intent obvious and removes any race where a
      // mid-transaction read might still see the rows.
      await tx.session.deleteMany({ where: { userId: targetUserId } });
      await tx.account.deleteMany({ where: { userId: targetUserId } });

      // The actual hard delete. All Cascade-FK dependents disappear as
      // a side effect; transferred references survive under the acting
      // admin's name.
      await tx.user.delete({ where: { id: targetUserId } });
    });
    this.realtime?.publishSessionsRevoked([targetUserId]);
    this.logger.log(
      `Admin ${actingUserId} HARD-deleted user ${targetUserId} (${target.email})`,
    );
    // The row is gone, so the name travels in metadata for the log to show.
    void this.auditLog.emit({
      organizationId: actor.organizationId,
      actorUserId: actingUserId,
      action: 'user.delete',
      target: `user:${targetUserId}`,
      metadata: { name: target.name, email: target.email },
    });
  }

  /**
   * Webmail mailboxes that exist on cPanel but aren't yet attached to a CRM
   * User. The admin imports one of these via {@link importWebmailUser} to
   * give it a CRM credential and pre-configure the Mail tab.
   */
  async listWebmailCandidates(actingUserId: string): Promise<{ items: WebmailCandidate[] }> {
    await this.assertAdmin(actingUserId);
    if (!this.cpanel.isEnabled()) return { items: [] };
    // Tenants never see the platform's mailboxes.
    if (!(await this.actorIsPlatform(actingUserId))) return { items: [] };

    const [mailboxes, existing] = await Promise.all([
      this.cpanel.listEmails(),
      this.prisma.client.user.findMany({
        select: { email: true },
        where: {
          email: {
            // isEnabled() above guarantees CPANEL_DOMAIN is set.
            endsWith: `@${(process.env.CPANEL_DOMAIN ?? '').trim().toLowerCase()}`,
          },
        },
      }),
    ]);
    const taken = new Set(existing.map((u) => u.email.toLowerCase()));
    const items = mailboxes
      .filter((m) => !taken.has(m.email.toLowerCase()))
      .map((m) => ({
        email: m.email,
        quotaMb: m.quotaMb,
        diskUsedBytes: m.diskUsedBytes,
      }));
    return { items };
  }

  /**
   * Import an existing webmail mailbox as a CRM user. The admin chooses a
   * password - it's set on BOTH sides:
   *   - CRM credential (Better Auth Account row)
   *   - cPanel mailbox (`Email::passwd_pop`)
   * so the user can sign in to the CRM and webmail with the same secret.
   *
   * The MailAccount is also provisioned automatically, mirroring the
   * `create` flow for cPanel-managed domains.
   */
  async importWebmailUser(
    actingUserId: string,
    actingWorkspaceId: string | null,
    input: AdminImportWebmailUserInput,
  ) {
    // Webmail import lands the new user on the cPanel-managed domain
    // (CPANEL_DOMAIN). The auto-route service will subsequently place them
    // in whichever org owns that email-domain - typically the root org.
    // Allowing a tenant admin from another org to invoke this would let
    // them seed users into a tenant they don't control, so we lock it to
    // global admin.
    await this.assertGlobalAdmin(actingUserId);
    if (!(await this.actorIsPlatform(actingUserId))) {
      throw new ForbiddenException({
        title: 'Platform only',
        status: 403,
        code: 'cpanel-platform-only',
      });
    }
    const email = input.email.toLowerCase().trim();

    if (!this.cpanel.isEnabled()) {
      throw new ForbiddenException({
        title: 'cPanel not configured',
        status: 503,
        detail: 'Webmail import requires the cPanel UAPI environment to be configured.',
      });
    }
    if (!this.cpanel.ownsEmail(email)) {
      throw new ForbiddenException({
        title: 'Domain not managed by cPanel',
        status: 400,
        detail: `${email} is not on the configured cPanel domain.`,
      });
    }

    const existingCrm = await this.prisma.client.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingCrm) {
      throw new ConflictException({
        title: 'User already in CRM',
        status: 409,
        detail: `${email} already has a CRM account. Edit the existing record instead.`,
      });
    }

    // Pin the imported user to the actor's own organization (the cPanel
    // mailboxes are the platform's, and import is SUPER_ADMIN-only, so that
    // is the root org) and validate the workspace BEFORE any side effect, so
    // a refused import never changes the cPanel password below. Never a
    // tenant's org, even one that claims the email domain: a platform
    // operator does not add people to a tenant. An org-less user would be
    // indistinguishable from SUPER_ADMIN in the HR services, so leaving it
    // null is not an option either.
    const importActor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { organizationId: true },
    });
    const importOrgId = importActor?.organizationId ?? ROOT_ORG_ID;
    if (input.workspaceId) {
      const ws = await this.prisma.client.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { organizationId: true },
      });
      if (!ws) {
        throw new NotFoundException({ title: 'Workspace not found', status: 404 });
      }
      if (ws.organizationId !== importOrgId) {
        throw new ForbiddenException({
          title: 'Workspace is outside your organization',
          status: 403,
        });
      }
    }

    // Confirm the mailbox actually exists on cPanel before writing anything
    // to the CRM - prevents an admin from "importing" a typo.
    const mailboxes = await this.cpanel.listEmails();
    if (!mailboxes.some((m) => m.email.toLowerCase() === email)) {
      throw new NotFoundException({
        title: 'Mailbox not found',
        status: 404,
        detail: `No webmail mailbox found for ${email}.`,
      });
    }

    // Align the cPanel password to the admin's chosen secret FIRST. If this
    // fails, abort before creating CRM state so we don't end up with a CRM
    // user whose Mail tab credentials are wrong.
    await this.cpanel.setPassword(email, input.password);

    const passwordHash = hashPassword(input.password);
    await this.prisma.client.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: input.name,
          emailVerified: true,
          systemRole: input.systemRole ?? 'EMPLOYEE',
          organizationId: importOrgId,
        },
      });
      await tx.account.create({
        data: {
          userId: created.id,
          providerId: 'credential',
          accountId: created.id,
          password: passwordHash,
        },
      });
      if (input.workspaceId) {
        await tx.workspaceMembership.create({
          data: {
            workspaceId: input.workspaceId,
            userId: created.id,
            role: input.workspaceRole ?? 'MEMBER',
            invitedById: actingUserId,
          },
        });
      }
    });

    const created = await this.prisma.client.user.findUnique({
      where: { email },
    });
    if (!created) throw new NotFoundException({ title: 'User not found', status: 404 });

    const autoMailWorkspaceId = input.workspaceId ?? actingWorkspaceId;
    const mailHosts = defaultMailHosts();
    if (autoMailWorkspaceId && mailHosts) {
      try {
        await this.mailAccounts.add(autoMailWorkspaceId, created.id, {
          email,
          displayName: input.name,
          imapHost: mailHosts.imapHost,
          imapPort: 993,
          imapSecure: true,
          smtpHost: mailHosts.smtpHost,
          smtpPort: 465,
          smtpSecure: true,
          username: email,
          password: input.password,
          isDefault: true,
        });
      } catch (err) {
        this.logger.warn(
          `Auto-MailAccount during import failed for ${email} message=${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    this.logger.log(
      `Admin ${actingUserId} imported webmail user ${created.id} email=${email}`,
    );
    void this.auditLog.emit({
      organizationId: importOrgId,
      actorUserId: actingUserId,
      action: 'user.create',
      target: `user:${created.id}`,
      metadata: { email, role: input.systemRole ?? 'EMPLOYEE', source: 'webmail_import' },
    });
    this.alertNewAdmin(importOrgId, actingUserId, created.id, input);
    return this.publicUser(created.id);
  }

  private async publicUser(id: string) {
    const row = await this.prisma.client.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        emailVerified: true,
        systemRole: true,
        timesheetExempt: true,
        customRoleId: true,
        createdAt: true,
      },
    });
    if (!row) throw new NotFoundException({ title: 'User not found', status: 404 });
    return row;
  }
}
