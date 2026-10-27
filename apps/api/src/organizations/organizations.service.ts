import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CreateOrganizationInput,
  CreateOrganizationResponse,
  InviteOrganizationOwnerInput,
  InviteOrganizationOwnerResponse,
  Organization,
  OrganizationSummary,
  OrgFeatureFlags,
  PublicOrganizationSignupInput,
  PublicOrganizationSignupResponse,
  PublicSignupMailConfigInput,
  UpdateOrganizationInput,
  UpsertOrganizationMailConfigInput,
} from '@botss/shared-types';
import { Prisma } from '@botss/database';

import { assertEmailDomainAllowed } from '../common/email-domain';
import { AuditLogService } from '../audit-log/audit-log.service';
import { assertNotClientAccount } from '../common/client-accounts';
import { decrypt, encrypt } from '../common/crypto/aes-gcm.util';
import { EmailService } from '../email/email.service';
import { RealtimeEventsService } from '../notifications/realtime-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { issueWorkspaceInvitation } from '../invitations/invitation-tokens';
import { withoutDeleteCounting } from '../security-alerts/delete-counting';
import { ROOT_ORG_ID, ROOT_ORG_SLUG } from './organizations.constants';
import { userHasCompanyPermission } from '../common/permissions/effective-permissions';

interface DecryptedMailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUser: string;
  imapPassword: string;
  fromEmail: string;
}

/**
 * Tenant organization management. Every mutation funnels through
 * `assertNotRoot` before touching the DB; the root row is also
 * protected by a Postgres trigger as a final safety net (see the
 * migration `20260522090000_organization_layer`).
 */
@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly realtime?: RealtimeEventsService,
  ) {}

  /** App-layer half of the root-protection contract. The trigger handles
   *  any path that goes around this method. */
  private assertNotRoot(orgId: string): void {
    if (orgId === ROOT_ORG_ID) {
      throw new ForbiddenException({
        title: 'Root organization protected',
        status: 403,
        detail: 'The Botss root organization cannot be suspended, deleted, or modified through this endpoint.',
      });
    }
  }

  private map(
    row: {
      id: string;
      name: string;
      slug: string;
      emailDomain: string | null;
      isRoot: boolean;
      isActive: boolean;
      featureFlags: unknown;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    },
  ): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      emailDomain: row.emailDomain,
      isRoot: row.isRoot,
      isActive: row.isActive,
      featureFlags: (row.featureFlags ?? {}) as OrgFeatureFlags,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  async list(): Promise<{ items: OrganizationSummary[] }> {
    // Single round-trip per side: fetch org rows + grouped counts and zip
    // them in JS. Avoids the N+1 pattern of running a count() per row.
    // We INCLUDE soft-deleted rows here so the admin can see archived
    // tenants and restore them - the soft-delete extension would
    // otherwise hide them by default.
    const [rows, memberCounts, workspaceCounts, acceptedCounts, storage, mailConfigs] =
      await Promise.all([
      (this.prisma.client.organization as unknown as {
        findMany: (args: unknown) => Promise<
          Array<{
            id: string;
            name: string;
            slug: string;
            emailDomain: string | null;
            isRoot: boolean;
            isActive: boolean;
            featureFlags: unknown;
            createdAt: Date;
            updatedAt: Date;
            deletedAt: Date | null;
          }>
        >;
      }).findMany({
        orderBy: [{ isRoot: 'desc' }, { name: 'asc' }],
        includeDeleted: true,
      }),
      this.prisma.client.user.groupBy({
        by: ['organizationId'],
        _count: { _all: true },
        where: { organizationId: { not: null }, deletedAt: null },
      }),
      this.prisma.client.workspace.groupBy({
        by: ['organizationId'],
        _count: { _all: true },
        // Workspace.organizationId is NOT NULL since the
        // 20260525190100_workspace_organization_required migration, so the
        // legacy `{ not: null }` filter is gone.
        where: { deletedAt: null },
      }),
      // "Accepted" = has a credential Account row. Group by organizationId
      // so we can detect "this tenant has at least one signed-in user".
      // Used to drive the Pending badge: a tenant with zero accepted
      // users is still waiting on its first sign-in.
      this.prisma.client.user.groupBy({
        by: ['organizationId'],
        _count: { _all: true },
        where: {
          organizationId: { not: null },
          deletedAt: null,
          accounts: { some: { providerId: 'credential' } },
        },
      }),
      // Usage only: total bytes of live files per org. Never file names.
      // `prisma.raw` has no soft-delete extension, so `deletedAt` is manual.
      this.prisma.raw.$queryRaw<Array<{ organizationId: string; bytes: bigint | null }>>`
        SELECT w."organizationId" AS "organizationId", SUM(f."sizeBytes")::bigint AS bytes
        FROM "FileObject" f
        JOIN "Workspace" w ON w."id" = f."workspaceId"
        WHERE f."deletedAt" IS NULL
        GROUP BY w."organizationId"
      `,
      // Whether mail is set up, never the settings themselves: an org's mail
      // server config is its own admins' business.
      this.prisma.client.organizationMailConfig.findMany({
        select: { organizationId: true },
      }),
    ]);
    const storageByOrg = new Map<string, number>(
      storage.map((r) => [r.organizationId, Number(r.bytes ?? 0)]),
    );
    const mailConfigured = new Set(mailConfigs.map((c) => c.organizationId));
    const memberByOrg = new Map<string, number>(
      memberCounts.flatMap((r) =>
        r.organizationId ? [[r.organizationId, r._count._all]] : [],
      ),
    );
    const wsByOrg = new Map<string, number>(
      workspaceCounts.map((r) => [r.organizationId, r._count._all]),
    );
    const acceptedByOrg = new Map<string, number>(
      acceptedCounts.flatMap((r) =>
        r.organizationId ? [[r.organizationId, r._count._all]] : [],
      ),
    );
    const items: OrganizationSummary[] = rows.map((r) => {
      const members = memberByOrg.get(r.id) ?? 0;
      const accepted = acceptedByOrg.get(r.id) ?? 0;
      // A tenant is pending until at least one of its members has
      // accepted their invitation (i.e. has a credential Account on
      // file). Root org never displays pending - it's seeded with the
      // founding admin. Tenants with zero members are also pending
      // (they exist as shells until an owner is invited and accepts).
      const pending = !r.isRoot && accepted === 0;
      return {
        ...this.map(r),
        memberCount: members,
        workspaceCount: wsByOrg.get(r.id) ?? 0,
        storageBytes: storageByOrg.get(r.id) ?? 0,
        mailConfigured: mailConfigured.has(r.id),
        pending,
      };
    });
    return { items };
  }

  async getById(orgId: string): Promise<Organization> {
    const row = await this.prisma.client.organization.findFirst({
      where: { id: orgId, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException({ title: 'Organization not found', status: 404 });
    }
    return this.map(row);
  }

  /**
   * Create a tenant org. If `firstOwner` is supplied we atomically provision
   * the tenant's first owner - User row inside the new org + a Workspace
   * named after the org + WorkspaceMembership(role=OWNER) - and mint a 7-day
   * invitation token that the existing public accept-invite page consumes.
   * This collapses the old "create org → switch to Users panel → create
   * user → wait for them to invite their team" dance into one form.
   *
   * Transactional contract: org + user + workspace + membership all commit
   * together or none of them do. The token row and the email send happen
   * after the transaction because the verification token is written through
   * the soft-delete extension (which uses its own client) and the email
   * dispatch enqueues a BullMQ job - neither belongs inside the interactive
   * tx scope.
   */
  async create(
    input: CreateOrganizationInput & { mailConfig?: PublicSignupMailConfigInput },
    actorUserId?: string,
  ): Promise<CreateOrganizationResponse> {
    if (input.slug === ROOT_ORG_SLUG || input.slug === ROOT_ORG_ID) {
      throw new ConflictException({
        title: 'Reserved slug',
        status: 409,
        detail: 'That slug is reserved for the root organization.',
      });
    }

    const firstOwner = input.firstOwner
      ? {
          email: input.firstOwner.email.trim().toLowerCase(),
          name: input.firstOwner.name?.trim() || undefined,
        }
      : null;

    // Catch admin typos before we touch the DB: if the tenant declared an
    // email domain, the bootstrap owner's address must live inside it.
    // Otherwise the user's auto-route lookup at first login would skip this
    // org and they'd land in the root tenant alongside The Botss staff,
    // which is the exact failure mode this whole flow is supposed to prevent.
    if (firstOwner && input.emailDomain) {
      const ownerDomain = firstOwner.email.split('@')[1]?.toLowerCase();
      if (ownerDomain !== input.emailDomain.toLowerCase()) {
        throw new BadRequestException({
          title: 'Owner email does not match the organization domain',
          status: 400,
          detail: `Expected an address ending in @${input.emailDomain}.`,
        });
      }
    }

    // Reject if the email is already attached to a User anywhere. Reassigning
    // an existing identity to a different org would silently flip their
    // workspace memberships' tenant - better to make the admin reconcile.
    if (firstOwner) {
      const existing = await this.prisma.client.user.findUnique({
        where: { email: firstOwner.email },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException({
          title: 'Email already in use',
          status: 409,
          detail:
            'A user with that email already exists. Invite them to a workspace inside this org instead.',
        });
      }
    }

    // Workspace slug derives from the org slug because the orgs admin
    // already picked a unique URL-safe handle. Workspace.slug is globally
    // unique so a legacy workspace could in principle already own that
    // handle - allocate before the transaction to keep the tx body small.
    // A tiny race window remains where a workspace with the chosen slug
    // gets created between this lookup and our insert; the outer P2002
    // catch handles it identically to an org-slug collision.
    const workspaceSlug = firstOwner
      ? await this.allocateWorkspaceSlug(input.slug)
      : null;

    type TxResult = {
      org: {
        id: string;
        name: string;
        slug: string;
        emailDomain: string | null;
        isRoot: boolean;
        isActive: boolean;
        featureFlags: unknown;
        createdAt: Date;
        updatedAt: Date;
        deletedAt: Date | null;
      };
      ownerUserId?: string;
      workspaceId?: string;
      workspaceName?: string;
    };

    let txResult: TxResult;
    try {
      txResult = await this.prisma.client.$transaction(async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: input.name,
            slug: input.slug,
            emailDomain: input.emailDomain ?? null,
            featureFlags: (input.featureFlags ?? {}) as Prisma.InputJsonValue,
          },
        });

        if (!firstOwner || !workspaceSlug) return { org };

        const ownerName =
          firstOwner.name ?? firstOwner.email.split('@')[0] ?? firstOwner.email;
        const user = await tx.user.create({
          data: {
            email: firstOwner.email,
            name: ownerName,
            emailVerified: false,
            timezone: 'Asia/Karachi',
            locale: 'en',
            organizationId: org.id,
            // The first user of a new org is its tenant admin: they manage
            // their own org's users via the (org-scoped) admin panel. Only a
            // SUPER_ADMIN can reach this path, so granting ADMIN here is safe.
            systemRole: 'ADMIN',
          },
        });

        const workspace = await tx.workspace.create({
          data: {
            name: input.name,
            slug: workspaceSlug,
            ownerId: user.id,
            organizationId: org.id,
            memberships: { create: { userId: user.id, role: 'OWNER' } },
          },
        });

        return {
          org,
          ownerUserId: user.id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          title: 'Duplicate organization',
          status: 409,
          detail: 'An organization with that slug or email domain already exists.',
        });
      }
      throw err;
    }

    if (input.mailConfig) {
      try {
        await this.upsertMailConfig(txResult.org.id, input.mailConfig);
      } catch (err) {
        this.logger.warn(
          `[ORG_BOOTSTRAP] mail config save failed for org=${txResult.org.id}: ${(err as Error)?.message ?? 'unknown'}`,
        );
      }
    }

    let invitationUrl: string | null = null;
    let invitationCode: string | null = null;
    if (firstOwner && txResult.ownerUserId && txResult.workspaceId) {
      const issued = await this.issueInvitationToken({
        workspaceId: txResult.workspaceId,
        userId: txResult.ownerUserId,
      });
      invitationUrl = issued.url;
      invitationCode = issued.code;
      await this.email.sendWorkspaceInvitation({
        to: firstOwner.email,
        recipientName: firstOwner.name ?? null,
        workspaceName: txResult.workspaceName ?? input.name,
        inviterName: null,
        url: issued.url,
        code: issued.code,
        organizationId: txResult.org.id,
      });
      this.logger.log(
        `[ORG_BOOTSTRAP] org=${txResult.org.id} owner=${firstOwner.email} workspace=${txResult.workspaceId}`,
      );
    }

    await this.auditLog.emit({
      organizationId: txResult.org.id,
      actorUserId: actorUserId ?? null,
      action: 'org.create',
      target: `organization:${txResult.org.id}`,
      metadata: {
        slug: txResult.org.slug,
        name: txResult.org.name,
        emailDomain: txResult.org.emailDomain,
        hadFirstOwner: firstOwner !== null,
      },
    });
    return { ...this.map(txResult.org), invitationUrl, invitationCode };
  }

  /**
   * Public self-serve signup (the "Are you an organization?" flow on the
   * sign-in page). Wraps `create()` so the provisioning contract is
   * identical to the admin flow - org + owner User (tenant ADMIN) +
   * Workspace + OWNER membership + emailed 7-day invitation - with three
   * public-facing differences:
   *
   *   1. The slug is server-generated from the organization name; visitors
   *      never pick (or probe) slugs.
   *   2. No emailDomain / featureFlags input - tenants start with defaults
   *      and a global admin can adjust later.
   *   3. The response is a bare `{ ok: true }`. The invitation URL must only
   *      travel via the owner's inbox: echoing it here would let anyone
   *      sign up with someone else's email and hijack the invite, turning
   *      this endpoint into an account-takeover primitive.
   *
   * Route-level rate limiting lives in main.ts (same pattern as the auth
   * and invitation limiters).
   */
  async signupSelfServe(
    input: PublicOrganizationSignupInput,
  ): Promise<PublicOrganizationSignupResponse> {
    // A public signup is never the platform org: the owner's address may not
    // sit on the cPanel domain or on a domain another tenant has claimed.
    await assertEmailDomainAllowed({
      orgId: null,
      actorOrgIsRoot: false,
      email: input.email,
      claimingOrgId: async (domain) => {
        const claim = await this.prisma.client.organization.findFirst({
          where: { emailDomain: domain, deletedAt: null },
          select: { id: true },
        });
        return claim?.id ?? null;
      },
    });
    const slug = await this.allocateOrgSlug(input.organizationName);
    const created = await this.create({
      name: input.organizationName.trim(),
      slug,
      firstOwner: { email: input.email, name: input.name },
      mailConfig: input.mailConfig,
    });
    this.logger.log(
      `[ORG_SELF_SIGNUP] org=${created.id} slug=${slug} owner=${input.email.trim().toLowerCase()} mail=${input.mailConfig ? 'yes' : 'no'}`,
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Tenant self-service mail config (org owner / admin, scoped to own org)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the org a tenant admin is allowed to manage, asserting they are an
   * organization admin first. `systemRole` ADMIN is the tenant-admin tier
   * (the org's first owner is provisioned as ADMIN); SUPER_ADMIN is the Botss
   * platform admin. Either way they may only ever touch their OWN org - the
   * id comes from their user row, never from the request - so this can't be
   * used to reach another tenant's mail config.
   */
  private async resolveAdminOrgId(userId: string): Promise<string> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { systemRole: true, organizationId: true },
    });
    if (!user || !(await userHasCompanyPermission(userId, 'org.settings'))) {
      throw new ForbiddenException({
        title: 'Only an organization admin can manage mail settings',
        status: 403,
      });
    }
    if (!user.organizationId) {
      throw new BadRequestException({
        title: 'No organization',
        status: 400,
        detail: 'Your account is not attached to an organization.',
      });
    }
    return user.organizationId;
  }

  /** Public mail fields for the caller's own org (or null if unset). */
  async getMailConfigForUser(userId: string) {
    const orgId = await this.resolveAdminOrgId(userId);
    return this.getMailConfig(orgId);
  }

  /** Upsert the caller's own org mail config. */
  async upsertMailConfigForUser(
    userId: string,
    input: UpsertOrganizationMailConfigInput,
  ) {
    const orgId = await this.resolveAdminOrgId(userId);
    return this.upsertMailConfig(orgId, input);
  }

  /**
   * Derive a unique org slug from a display name for the self-serve flow.
   * Org slugs are globally unique (and soft-deleted rows still hold their
   * slug), so check via the raw client and fall back to random suffixes.
   * `create()` still catches P2002 for the residual race window.
   */
  private async allocateOrgSlug(orgName: string): Promise<string> {
    const slugified = orgName
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    // createOrganizationSchema requires slug.min(2): pad degenerate names.
    const base = slugified.length >= 2 ? slugified : 'org';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      if (candidate === ROOT_ORG_SLUG || candidate === ROOT_ORG_ID) continue;
      const clash = await this.prisma.raw.organization.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    throw new ConflictException({
      title: "Couldn't create a web address for this organization",
      status: 409,
      detail: 'Try a slightly different organization name.',
    });
  }

  /**
   * Retroactive owner invite for an existing tenant that has no owner yet
   * (orgs created before the create-with-owner flow shipped, or where the
   * admin skipped the optional first-owner fields). Idempotent in spirit:
   * if the email is already attached to a User elsewhere we reject so the
   * admin can't silently rebind an identity to a different tenant.
   *
   * Operation:
   *   1. Validate the org exists, isn't root, isn't archived.
   *   2. Reuse an existing workspace in the org if one is present, else
   *      bootstrap a fresh one.
   *   3. Create the User pinned to the org, attach them as OWNER of the
   *      target workspace, mint a 7-day invitation token, send email.
   *
   * Audit-emits `org.invite_owner` so the action is traceable.
   */
  async inviteFirstOwner(
    orgId: string,
    input: InviteOrganizationOwnerInput,
    actorUserId?: string,
  ): Promise<InviteOrganizationOwnerResponse> {
    this.assertNotRoot(orgId);
    const org = await this.getById(orgId);
    if (!org.isActive || org.deletedAt) {
      throw new BadRequestException({
        title: 'Organization is not active',
        status: 400,
        detail: 'Cannot invite an owner to an archived or suspended tenant.',
      });
    }

    const email = input.email.trim().toLowerCase();
    const name = input.name?.trim() || undefined;

    // Same domain-match safety as the create flow: catches admin typos.
    if (org.emailDomain) {
      const ownerDomain = email.split('@')[1]?.toLowerCase();
      if (ownerDomain !== org.emailDomain.toLowerCase()) {
        throw new BadRequestException({
          title: 'Owner email does not match the organization domain',
          status: 400,
          detail: `Expected an address ending in @${org.emailDomain}.`,
        });
      }
    }

    const existingUser = await this.prisma.client.user.findUnique({
      where: { email },
      select: {
        id: true,
        organizationId: true,
        accountType: true,
        emailVerified: true,
        accounts: {
          where: { providerId: 'credential' },
          select: { id: true },
          take: 1,
        },
      },
    });

    if (existingUser) {
      // A client-portal account has no org, so the check below would let it
      // through and the adoption further down would make it a workspace
      // OWNER with systemRole ADMIN. Portal accounts are never adopted.
      assertNotClientAccount(existingUser.accountType);
      // Hard block: identity belongs to another tenant. Re-binding would
      // silently collapse the cross-org wall.
      if (
        existingUser.organizationId &&
        existingUser.organizationId !== orgId
      ) {
        throw new ConflictException({
          title: 'Email already in use',
          status: 409,
          detail: 'A user with that email already exists in another organization.',
        });
      }

      const hasCredential = existingUser.accounts.length > 0;

      // Is there a workspace they could still OWN inside this org? Only
      // memberships pointing at workspaces in *this* org count - cross-org
      // rows have already been dropped server-side by the scope guard.
      const existingOwnerMembership =
        await this.prisma.client.workspaceMembership.findFirst({
          where: {
            userId: existingUser.id,
            role: 'OWNER',
            workspace: { organizationId: orgId, deletedAt: null },
          },
          select: {
            workspaceId: true,
            workspace: { select: { id: true, name: true } },
          },
        });

      // Case A: pending owner with the original OWNER membership intact ->
      // standard resend (reissue token + email).
      if (!hasCredential && existingOwnerMembership) {
        await this.prisma.client.user.update({
          where: { id: existingUser.id },
          data: { systemRole: 'ADMIN' },
        });
        const { url: invitationUrl, code: invitationCode } = await this.issueInvitationToken({
          workspaceId: existingOwnerMembership.workspaceId,
          userId: existingUser.id,
        });
        await this.email.sendWorkspaceInvitation({
          to: email,
          recipientName: name ?? null,
          workspaceName: existingOwnerMembership.workspace.name,
          inviterName: null,
          url: invitationUrl,
          code: invitationCode,
          organizationId: orgId,
        });
        await this.auditLog.emit({
          organizationId: orgId,
          actorUserId: actorUserId ?? null,
          action: 'org.invite_owner',
          target: `user:${existingUser.id}`,
          metadata: {
            email,
            workspaceId: existingOwnerMembership.workspaceId,
            resend: true,
          },
        });
        return {
          organization: org,
          invitationUrl,
          invitationCode,
          workspaceId: existingOwnerMembership.workspaceId,
        };
      }

      // Case B: fully onboarded AND still attached as OWNER -> nothing to do.
      if (hasCredential && existingOwnerMembership) {
        throw new ConflictException({
          title: 'Already the owner',
          status: 409,
          detail:
            'This user already owns a workspace in this organization. Ask them to sign in with their existing password.',
        });
      }

      // Case C: user exists in this org (possibly with a password) but no
      // longer holds an OWNER workspace membership. Happens when an admin
      // removed the user from the workspace earlier. Re-attach them as
      // OWNER of an existing workspace in the org (or bootstrap one) and
      // - if they DON'T have a password - email a fresh invitation. With
      // a password we skip the email and tell the admin to share the
      // sign-in URL directly.
      const reattachWorkspace = await this.prisma.client.workspace.findFirst({
        where: { organizationId: orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
      });
      let attachWorkspaceId: string;
      let attachWorkspaceName: string;
      if (reattachWorkspace) {
        attachWorkspaceId = reattachWorkspace.id;
        attachWorkspaceName = reattachWorkspace.name;
      } else {
        const workspaceSlug = await this.allocateWorkspaceSlug(org.slug);
        const newWs = await this.prisma.client.workspace.create({
          data: {
            name: org.name,
            slug: workspaceSlug,
            ownerId: existingUser.id,
            organizationId: orgId,
          },
        });
        attachWorkspaceId = newWs.id;
        attachWorkspaceName = newWs.name;
      }
      await this.prisma.client.workspaceMembership.create({
        data: {
          workspaceId: attachWorkspaceId,
          userId: existingUser.id,
          role: 'OWNER',
          invitedById: actorUserId ?? null,
        },
      });
      // Keep tenant ADMIN role current.
      await this.prisma.client.user.update({
        where: { id: existingUser.id },
        data: {
          systemRole: 'ADMIN',
          ...(existingUser.organizationId === null ? { organizationId: orgId } : {}),
        },
      });

      if (hasCredential) {
        // Already onboarded; no need to email a "set password" link. Just
        // hand back the workspace + an "open the app" URL so the admin
        // can pass it along if they want.
        const appUrl =
          this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
        await this.auditLog.emit({
          organizationId: orgId,
          actorUserId: actorUserId ?? null,
          action: 'org.invite_owner',
          target: `user:${existingUser.id}`,
          metadata: {
            email,
            workspaceId: attachWorkspaceId,
            reattach: true,
            hadPassword: true,
          },
        });
        return {
          organization: org,
          invitationUrl: `${appUrl.replace(/\/$/, '')}/sign-in`,
          workspaceId: attachWorkspaceId,
        };
      }

      // No password on file - send the standard invitation flow.
      const { url: invitationUrl, code: invitationCode } = await this.issueInvitationToken({
        workspaceId: attachWorkspaceId,
        userId: existingUser.id,
      });
      await this.email.sendWorkspaceInvitation({
        to: email,
        recipientName: name ?? null,
        workspaceName: attachWorkspaceName,
        inviterName: null,
        url: invitationUrl,
        code: invitationCode,
        organizationId: orgId,
      });
      await this.auditLog.emit({
        organizationId: orgId,
        actorUserId: actorUserId ?? null,
        action: 'org.invite_owner',
        target: `user:${existingUser.id}`,
        metadata: {
          email,
          workspaceId: attachWorkspaceId,
          reattach: true,
          hadPassword: false,
        },
      });
      return {
        organization: org,
        invitationUrl,
        invitationCode,
        workspaceId: attachWorkspaceId,
      };
    }

    // Reuse the first existing workspace in the org as the owner's home;
    // if the org has none (typical for legacy "shell" tenants), allocate
    // a new one named after the org. Slug allocation handles workspace
    // slug collisions via the same helper the create-flow uses.
    let workspaceId: string;
    let workspaceName: string;
    const existingWorkspace = await this.prisma.client.workspace.findFirst({
      where: { organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    });

    const ownerName = name ?? email.split('@')[0] ?? email;
    if (existingWorkspace) {
      const user = await this.prisma.client.user.create({
        data: {
          email,
          name: ownerName,
          emailVerified: false,
          timezone: 'Asia/Karachi',
          locale: 'en',
          organizationId: orgId,
          // First owner of the org is its tenant admin (see create()).
          systemRole: 'ADMIN',
        },
      });
      await this.prisma.client.workspaceMembership.create({
        data: {
          workspaceId: existingWorkspace.id,
          userId: user.id,
          role: 'OWNER',
          invitedById: actorUserId ?? null,
        },
      });
      workspaceId = existingWorkspace.id;
      workspaceName = existingWorkspace.name;

      const { url: invitationUrl, code: invitationCode } = await this.issueInvitationToken({
        workspaceId,
        userId: user.id,
      });
      await this.email.sendWorkspaceInvitation({
        to: email,
        recipientName: name ?? null,
        workspaceName,
        inviterName: null,
        url: invitationUrl,
        code: invitationCode,
        organizationId: orgId,
      });
      await this.auditLog.emit({
        organizationId: orgId,
        actorUserId: actorUserId ?? null,
        action: 'org.invite_owner',
        target: `user:${user.id}`,
        metadata: { email, workspaceId, reusedExistingWorkspace: true },
      });
      return { organization: org, invitationUrl, invitationCode, workspaceId };
    }

    // No existing workspace - bootstrap one. Mirrors the create-with-owner
    // path so the customer sees the same shape as a brand-new tenant.
    const workspaceSlug = await this.allocateWorkspaceSlug(org.slug);
    const result = await this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: ownerName,
          emailVerified: false,
          timezone: 'Asia/Karachi',
          locale: 'en',
          organizationId: orgId,
          // First owner of the org is its tenant admin (see create()).
          systemRole: 'ADMIN',
        },
      });
      const workspace = await tx.workspace.create({
        data: {
          name: org.name,
          slug: workspaceSlug,
          ownerId: user.id,
          organizationId: orgId,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
      return { userId: user.id, workspaceId: workspace.id, workspaceName: workspace.name };
    });

    workspaceId = result.workspaceId;
    workspaceName = result.workspaceName;
    const { url: invitationUrl, code: invitationCode } = await this.issueInvitationToken({
      workspaceId,
      userId: result.userId,
    });
    await this.email.sendWorkspaceInvitation({
      to: email,
      recipientName: name ?? null,
      workspaceName,
      inviterName: null,
      url: invitationUrl,
      code: invitationCode,
      organizationId: orgId,
    });
    await this.auditLog.emit({
      organizationId: orgId,
      actorUserId: actorUserId ?? null,
      action: 'org.invite_owner',
      target: `user:${result.userId}`,
      metadata: { email, workspaceId, reusedExistingWorkspace: false },
    });
    return { organization: org, invitationUrl, invitationCode, workspaceId };
  }

  /**
   * Pick a workspace slug for the org-bootstrap flow. Workspace.slug is
   * globally unique so we cannot blindly reuse the org slug - a legacy
   * workspace might already own that handle. Try the org slug first, then
   * append a short suffix; bail after a few attempts rather than looping
   * forever.
   */
  private async allocateWorkspaceSlug(base: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
      const clash = await this.prisma.client.workspace.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }
    throw new ConflictException({
      title: "Couldn't create a web address for this workspace",
      status: 409,
      detail: 'Try a different organization slug.',
    });
  }

  /**
   * Mint a 7-day invitation link + code using the same `workspace-invite:`
   * identifier the workspace-invite flow uses, so the public accept page
   * handles the org-bootstrap owner with zero changes.
   */
  private async issueInvitationToken(args: {
    workspaceId: string;
    userId: string;
  }): Promise<{ url: string; code: string }> {
    const appUrl =
      this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
    return issueWorkspaceInvitation(this.prisma, appUrl, args);
  }

  async update(
    orgId: string,
    input: UpdateOrganizationInput,
    actorUserId?: string,
  ): Promise<Organization> {
    this.assertNotRoot(orgId);
    const data: Prisma.OrganizationUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.emailDomain !== undefined) data.emailDomain = input.emailDomain;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.featureFlags !== undefined) {
      data.featureFlags = input.featureFlags as Prisma.InputJsonValue;
    }
    try {
      const row = await this.prisma.client.organization.update({
        where: { id: orgId },
        data,
      });
      await this.auditLog.emit({
        organizationId: orgId,
        actorUserId: actorUserId ?? null,
        action: 'org.update',
        target: `organization:${orgId}`,
        metadata: { changes: input },
      });
      return this.map(row);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException({ title: 'Organization not found', status: 404 });
      }
      throw err;
    }
  }

  async softDelete(orgId: string, actorUserId?: string): Promise<{ ok: true }> {
    this.assertNotRoot(orgId);
    // Reversible "archive": flip deletedAt + isActive. Users of this org
    // are kicked out of every authenticated request by AuthGuard (which
    // reads `orgInactive` from `getUserOrgContext`); their data stays in
    // place so a restore brings the tenant back without further work.
    await this.prisma.client.organization.update({
      where: { id: orgId },
      data: { deletedAt: new Date(), isActive: false },
    });
    // Kill any live sessions so the tenant's users are signed out the
    // moment the archive lands - without this they'd carry a valid cookie
    // until natural expiry and the AuthGuard 401 only fires on their next
    // request. Hard-deleting Session rows is safe; they're regenerated on
    // sign-in after a future restore.
    const users = await this.prisma.client.user.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    if (users.length > 0) {
      await this.prisma.client.session.deleteMany({
        where: { userId: { in: users.map((u) => u.id) } },
      });
      this.realtime?.publishSessionsRevoked(users.map((u) => u.id));
    }
    // Client-portal people carry no organizationId, so the sweep above misses
    // them. The portal already hides an archived org's clients; also sign out
    // those whose only access ran through this org. Their contacts stay, so a
    // restore brings them back too.
    const portalContacts = await this.prisma.client.clientContact.findMany({
      where: { deletedAt: null, client: { workspace: { organizationId: orgId } } },
      select: { userId: true },
    });
    const portalUserIds = [...new Set(portalContacts.map((c) => c.userId))];
    if (portalUserIds.length > 0) {
      const elsewhere = await this.prisma.client.clientContact.findMany({
        where: {
          deletedAt: null,
          userId: { in: portalUserIds },
          client: { workspace: { organizationId: { not: orgId } } },
        },
        select: { userId: true },
      });
      const keep = new Set(elsewhere.map((c) => c.userId));
      const onlyHere = portalUserIds.filter((id) => !keep.has(id));
      if (onlyHere.length > 0) {
        await this.prisma.client.session.deleteMany({ where: { userId: { in: onlyHere } } });
        this.realtime?.publishSessionsRevoked(onlyHere);
      }
    }
    await this.auditLog.emit({
      organizationId: orgId,
      actorUserId: actorUserId ?? null,
      action: 'org.archive',
      target: `organization:${orgId}`,
      metadata: { usersBlocked: users.length },
    });
    return { ok: true };
  }

  /** Reverse a soft-delete. Workspaces/users/data all reappear. Requires
   *  `includeDeleted` to bypass the soft-delete read filter. */
  async restore(orgId: string, actorUserId?: string): Promise<Organization> {
    this.assertNotRoot(orgId);
    const row = await (this.prisma.client.organization as unknown as {
      findFirst: (args: unknown) => Promise<{
        id: string;
        deletedAt: Date | null;
      } | null>;
    }).findFirst({ where: { id: orgId }, includeDeleted: true });
    if (!row) {
      throw new NotFoundException({ title: 'Organization not found', status: 404 });
    }
    if (!row.deletedAt) {
      throw new BadRequestException({
        title: 'Not archived',
        status: 400,
        detail: 'This organization is already active.',
      });
    }
    const updated = await this.prisma.client.organization.update({
      where: { id: orgId },
      data: { deletedAt: null, isActive: true },
    });
    await this.auditLog.emit({
      organizationId: orgId,
      actorUserId: actorUserId ?? null,
      action: 'org.restore',
      target: `organization:${orgId}`,
    });
    return this.map(updated);
  }

  /**
   * **Irreversible.** Hard-delete the org and cascade through every dependent
   * row in a single transaction. Use only when you're certain the tenant
   * should be gone forever - the soft-delete path (`softDelete`) is what
   * customer-facing "archive" should call.
   *
   * Order of operations matters because the FK chains form a directed graph:
   * we walk the tree leaves-first (TimeEntry, DocumentAccess, Todo, comments,
   * task links…) before deleting the trunk (workspaces, users, mailboxes,
   * the org itself). Anything not enumerated here will trip a FK violation
   * and abort the transaction - which is what we want.
   */
  async hardDelete(
    orgId: string,
    actorUserId?: string,
  ): Promise<{ ok: true; mode: 'hard' }> {
    this.assertNotRoot(orgId);
    // Everyone whose sessions the purge deletes; their sockets are closed
    // once the transaction has committed.
    const revoked: string[] = [];
    // Recorded in the tombstone audit row: the org row itself is purged.
    let purgedName: string | null = null;
    // Read inside a transaction so the workspace + user id sets are
    // consistent with the deletes that follow. A purge is not a person's
    // mass delete, so security alerts do not count its deletes (the raw
    // client bypasses the soft-delete hook today; this keeps it so).
    await withoutDeleteCounting(() => this.prisma.raw.$transaction(
      async (tx) => {
        const org = await tx.organization.findFirst({
          where: { id: orgId },
        });
        if (!org) {
          throw new NotFoundException({
            title: 'Organization not found',
            status: 404,
          });
        }
        purgedName = org.name;
        const workspaces = await tx.workspace.findMany({
          where: { organizationId: orgId },
          select: { id: true },
        });
        const users = await tx.user.findMany({
          where: { organizationId: orgId },
          select: { id: true },
        });
        const workspaceIds = workspaces.map((w) => w.id);
        const userIds = users.map((u) => u.id);

        // Pre-clear session + credential rows so deleted users can't sign
        // back in even if a fragment of cascade falls behind.
        await tx.session.deleteMany({ where: { userId: { in: userIds } } });
        await tx.account.deleteMany({ where: { userId: { in: userIds } } });
        revoked.push(...userIds);

        // Client-portal people reach this org only through its clients'
        // contacts and carry no organizationId, so the user sweep above
        // misses them. Note them now - the contacts cascade away with the
        // workspaces below.
        const portalContacts = await tx.clientContact.findMany({
          where: { client: { workspace: { organizationId: orgId } } },
          select: { userId: true },
        });
        const portalUserIds = [...new Set(portalContacts.map((c) => c.userId))];

        // Drop the workspaces - `onDelete: Cascade` on Project, Lead, Client,
        // Document, FileObject, etc. takes care of the per-workspace trees.
        await tx.workspace.deleteMany({ where: { id: { in: workspaceIds } } });

        // Portal accounts left with no client anywhere else go with the org.
        if (portalUserIds.length > 0) {
          const remaining = await tx.clientContact.findMany({
            where: { userId: { in: portalUserIds } },
            select: { userId: true },
          });
          const keep = new Set(remaining.map((c) => c.userId));
          const orphaned = portalUserIds.filter((id) => !keep.has(id));
          if (orphaned.length > 0) {
            revoked.push(...orphaned);
            await tx.session.deleteMany({ where: { userId: { in: orphaned } } });
            await tx.account.deleteMany({ where: { userId: { in: orphaned } } });
            await tx.user.deleteMany({ where: { id: { in: orphaned }, accountType: 'CLIENT' } });
          }
        }

        // User-keyed rows that don't cascade from Workspace: Attendance,
        // Leave, TimeEntry, Todo, Notifications. Drop them via the user id
        // set so nothing dangles.
        await tx.attendance.deleteMany({ where: { userId: { in: userIds } } });
        await tx.leave.deleteMany({ where: { userId: { in: userIds } } });
        await tx.timeEntry.deleteMany({ where: { userId: { in: userIds } } });
        await tx.todo.deleteMany({ where: { userId: { in: userIds } } });
        await tx.notification.deleteMany({ where: { userId: { in: userIds } } });
        await tx.mailAccount.deleteMany({ where: { userId: { in: userIds } } });

        // Now the users - finally - and the org-level mail config.
        await tx.organizationMailConfig.deleteMany({
          where: { organizationId: orgId },
        });
        await tx.user.deleteMany({ where: { id: { in: userIds } } });

        // The org itself. Use the raw client because the soft-delete
        // extension would otherwise convert `delete` into an `update`,
        // leaving the tombstone we explicitly want gone.
        await tx.organization.delete({ where: { id: orgId } });
      },
      { timeout: 30_000 },
    ));
    this.realtime?.publishSessionsRevoked(revoked);
    // Audit emit happens AFTER cascade - but the org row itself is now
    // gone, so we use the root org as the home for this final tombstone
    // event. Otherwise the FK would reject the insert. The metadata
    // carries the original orgId for traceability.
    await this.auditLog.emit({
      organizationId: ROOT_ORG_ID,
      actorUserId: actorUserId ?? null,
      action: 'org.hard_delete',
      target: `organization:${orgId}`,
      metadata: { purgedOrgId: orgId, name: purgedName },
    });
    this.logger.warn(`[ORG_HARD_DELETE] tenant ${orgId} purged.`);
    return { ok: true, mode: 'hard' };
  }

  // ---------------------------------------------------------------------------
  // Mail config (per-org IMAP/SMTP fallback)
  // ---------------------------------------------------------------------------

  /** Returns the public fields only - never the ciphertext or decrypted values. */
  async getMailConfig(orgId: string) {
    const row = await this.prisma.client.organizationMailConfig.findUnique({
      where: { organizationId: orgId },
    });
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organizationId,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUser: row.smtpUser,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      imapSecure: row.imapSecure,
      imapUser: row.imapUser,
      fromEmail: row.fromEmail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Upsert pattern: if a password isn't provided we keep the previously
   * stored ciphertext. Plaintext passwords arrive over the wire only for
   * this call, are immediately encrypted, and are never logged or echoed
   * back in any response.
   */
  async upsertMailConfig(
    orgId: string,
    input: UpsertOrganizationMailConfigInput,
  ) {
    await this.getById(orgId);
    const existing = await this.prisma.client.organizationMailConfig.findUnique({
      where: { organizationId: orgId },
    });
    if (!existing && (!input.smtpPassword || !input.imapPassword)) {
      throw new BadRequestException({
        title: 'Initial save requires both passwords',
        status: 400,
        detail:
          'When configuring mail for the first time, provide both SMTP and IMAP passwords.',
      });
    }
    const smtpPasswordCt =
      input.smtpPassword !== undefined
        ? encrypt(input.smtpPassword)
        : existing!.smtpPasswordCt;
    const imapPasswordCt =
      input.imapPassword !== undefined
        ? encrypt(input.imapPassword)
        : existing!.imapPasswordCt;
    const row = await this.prisma.client.organizationMailConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecure: input.smtpSecure,
        smtpUser: input.smtpUser,
        smtpPasswordCt,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecure: input.imapSecure,
        imapUser: input.imapUser,
        imapPasswordCt,
        fromEmail: input.fromEmail,
      },
      update: {
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpSecure: input.smtpSecure,
        smtpUser: input.smtpUser,
        smtpPasswordCt,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapSecure: input.imapSecure,
        imapUser: input.imapUser,
        imapPasswordCt,
        fromEmail: input.fromEmail,
      },
    });
    return this.publicMailFields(row);
  }

  /**
   * Used by the mail transport builder. Returns DECRYPTED credentials in
   * memory only - never persist, never log, never include in a response.
   */
  async resolveDecryptedMailConfig(
    orgId: string,
  ): Promise<DecryptedMailConfig | null> {
    const row = await this.prisma.client.organizationMailConfig.findUnique({
      where: { organizationId: orgId },
    });
    if (!row) return null;
    return {
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUser: row.smtpUser,
      smtpPassword: decrypt(row.smtpPasswordCt),
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      imapSecure: row.imapSecure,
      imapUser: row.imapUser,
      imapPassword: decrypt(row.imapPasswordCt),
      fromEmail: row.fromEmail,
    };
  }

  private publicMailFields(row: {
    id: string;
    organizationId: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    imapHost: string;
    imapPort: number;
    imapSecure: boolean;
    imapUser: string;
    fromEmail: string;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      smtpHost: row.smtpHost,
      smtpPort: row.smtpPort,
      smtpSecure: row.smtpSecure,
      smtpUser: row.smtpUser,
      imapHost: row.imapHost,
      imapPort: row.imapPort,
      imapSecure: row.imapSecure,
      imapUser: row.imapUser,
      fromEmail: row.fromEmail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
