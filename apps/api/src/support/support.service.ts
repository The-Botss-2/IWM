import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  activeSupportGrantListResponseSchema,
  resolveSupportGrantExpiry,
  supportGrantListResponseSchema,
  supportGrantSchema,
  supportGrantStatus,
  supportSessionSchema,
  type ActiveSupportGrantListResponse,
  type CreateSupportGrantInput,
  type SupportGrant,
  type SupportGrantListResponse,
  type SupportSession,
} from '@botss/shared-types';

import { AuditLogService } from '../audit-log/audit-log.service';
import { userHasCompanyPermission } from '../common/permissions/effective-permissions';
import { ROOT_ORG_ID } from '../organizations/organizations.constants';
import { PrismaService } from '../prisma/prisma.service';
import { supportLogUnavailable, supportNotAllowed, supportSessionEnded } from './support-rules';
import { signSupportToken, supportTokenSecret } from './support-token';

/** How many past grants the settings card lists. */
const LIST_LIMIT = 50;

const userSummarySelect = { id: true, name: true, email: true, image: true } as const;

const grantSelect = {
  id: true,
  expiresAt: true,
  revokedAt: true,
  readOnly: true,
  reason: true,
  createdAt: true,
  grantedBy: { select: userSummarySelect },
  revokedBy: { select: userSummarySelect },
} as const;

type GrantRow = {
  id: string;
  expiresAt: Date;
  revokedAt: Date | null;
  readOnly: boolean;
  reason: string | null;
  createdAt: Date;
  grantedBy: { id: string; name: string; email: string; image: string | null } | null;
  revokedBy: { id: string; name: string; email: string; image: string | null } | null;
};

/**
 * Support access grants. Organization admins (company `org.settings`) create,
 * list and revoke grants for their own organization; platform operators
 * (SUPER_ADMIN, root organization) see which organizations currently allow
 * support and open a read only session into one. The per-request checks of a
 * running session live in `SupportSessionService`.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private async assertOrgAdmin(actorId: string): Promise<void> {
    if (!(await userHasCompanyPermission(actorId, 'org.settings'))) {
      throw new ForbiddenException({
        title: 'Not allowed',
        status: 403,
        detail: 'Only people who can manage company settings can manage support access.',
        code: 'support-grant-forbidden',
      });
    }
  }

  async listGrants(actorId: string, organizationId: string, now = new Date()): Promise<SupportGrantListResponse> {
    await this.assertOrgAdmin(actorId);
    const rows: GrantRow[] = await this.prisma.client.supportGrant.findMany({
      where: { organizationId },
      select: grantSelect,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return supportGrantListResponseSchema.parse({ items: rows.map((r) => toGrant(r, now)) });
  }

  async createGrant(
    actorId: string,
    organizationId: string,
    input: CreateSupportGrantInput,
    now = new Date(),
  ): Promise<SupportGrant> {
    await this.assertOrgAdmin(actorId);
    const expiry = resolveSupportGrantExpiry(input, now);
    if (!expiry.ok) {
      throw new BadRequestException({
        title: "Couldn't grant support access",
        status: 400,
        detail: expiry.reason,
        code: expiry.code,
      });
    }
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    const row: GrantRow = await this.prisma.client.supportGrant.create({
      data: {
        organizationId,
        grantedById: actorId,
        expiresAt: expiry.expiresAt,
        readOnly: true,
        reason,
      },
      select: grantSelect,
    });
    await this.auditLog.emit({
      organizationId,
      actorUserId: actorId,
      action: 'support.grant_created',
      target: `organization:${organizationId}`,
      metadata: { expiresAt: row.expiresAt.toISOString(), readOnly: row.readOnly },
    });
    return supportGrantSchema.parse(toGrant(row, now));
  }

  async revokeGrant(
    actorId: string,
    organizationId: string,
    grantId: string,
    now = new Date(),
  ): Promise<SupportGrant> {
    await this.assertOrgAdmin(actorId);
    const existing = await this.prisma.client.supportGrant.findFirst({
      where: { id: grantId, organizationId },
      select: { id: true, revokedAt: true, expiresAt: true, readOnly: true },
    });
    if (!existing) throw grantNotFound();
    if (supportGrantStatus(existing, now) !== 'ACTIVE') throw grantNotActive();
    // Conditional update: two admins revoking at once revoke exactly once.
    const result = await this.prisma.client.supportGrant.updateMany({
      where: { id: grantId, organizationId, revokedAt: null },
      data: { revokedAt: now, revokedById: actorId },
    });
    if (result.count === 0) throw grantNotActive();
    await this.auditLog.emit({
      organizationId,
      actorUserId: actorId,
      action: 'support.grant_revoked',
      target: `organization:${organizationId}`,
      metadata: { expiresAt: existing.expiresAt.toISOString(), readOnly: existing.readOnly },
    });
    const row: GrantRow | null = await this.prisma.client.supportGrant.findFirst({
      where: { id: grantId, organizationId },
      select: grantSelect,
    });
    if (!row) throw grantNotFound();
    return supportGrantSchema.parse(toGrant(row, now));
  }

  /** Platform operator: organizations whose support grant is active now. */
  async listActive(actorId: string, now = new Date()): Promise<ActiveSupportGrantListResponse> {
    await this.assertPlatformOperator(actorId);
    const rows = await this.prisma.client.supportGrant.findMany({
      where: {
        revokedAt: null,
        expiresAt: { gt: now },
        organization: { deletedAt: null, isActive: true },
      },
      select: {
        id: true,
        organizationId: true,
        expiresAt: true,
        readOnly: true,
        reason: true,
        organization: { select: { name: true } },
      },
      orderBy: { expiresAt: 'desc' },
      take: 500,
    });
    // One grant per organization: the one that ends last (rows come latest
    // ending first), so "Open as support" never picks a grant about to end.
    const seen = new Set<string>();
    const latest = rows.filter((r) => {
      if (seen.has(r.organizationId)) return false;
      seen.add(r.organizationId);
      return true;
    });
    return activeSupportGrantListResponseSchema.parse({
      items: latest.map((r) => ({
        grantId: r.id,
        organizationId: r.organizationId,
        organizationName: r.organization.name,
        expiresAt: r.expiresAt,
        readOnly: r.readOnly,
        reason: r.reason,
      })),
    });
  }

  /**
   * Platform operator: open a read only support session on an active grant.
   * The token is tied to this grant, this user and this sign-in session, and
   * expires with the grant.
   */
  async startSession(
    actorId: string,
    sessionId: string | undefined,
    grantId: string,
    now = new Date(),
  ): Promise<SupportSession> {
    await this.assertPlatformOperator(actorId);
    if (!sessionId) throw supportNotAllowed();
    const secret = supportTokenSecret();
    if (!secret) throw supportNotAllowed();
    const grant = await this.prisma.client.supportGrant.findFirst({
      where: { id: grantId, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        organizationId: true,
        expiresAt: true,
        readOnly: true,
        organization: { select: { name: true, isActive: true, deletedAt: true } },
      },
    });
    if (!grant || !grant.organization.isActive || grant.organization.deletedAt !== null) {
      throw supportSessionEnded();
    }
    const token = signSupportToken(
      { g: grant.id, u: actorId, s: sessionId, e: grant.expiresAt.getTime() },
      secret,
    );
    // On the granted organization's record before the token is handed out.
    // Like `support.access`, a failed insert refuses (never `emit`).
    try {
      await this.prisma.client.auditLog.create({
        data: {
          organizationId: grant.organizationId,
          actorUserId: actorId,
          action: 'support.session_started',
          target: null,
          metadata: { grantId: grant.id },
        },
        select: { id: true },
      });
    } catch (err) {
      this.logger.error(
        `support.session_started log failed org=${grant.organizationId} grant=${grant.id} ` +
          `message=${(err as Error)?.message ?? 'unknown'}`,
      );
      throw supportLogUnavailable();
    }
    return supportSessionSchema.parse({
      token,
      grantId: grant.id,
      organizationId: grant.organizationId,
      organizationName: grant.organization.name,
      expiresAt: grant.expiresAt,
      readOnly: grant.readOnly,
    });
  }

  /** SUPER_ADMIN of the root organization, read from the database. */
  private async assertPlatformOperator(actorId: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: actorId },
      select: { systemRole: true, organizationId: true, accountType: true },
    });
    if (
      !user ||
      user.systemRole !== 'SUPER_ADMIN' ||
      user.organizationId !== ROOT_ORG_ID ||
      user.accountType !== 'STAFF'
    ) {
      throw supportNotAllowed();
    }
  }
}

function grantNotFound(): NotFoundException {
  return new NotFoundException({
    title: 'Support grant not found',
    status: 404,
    detail: 'That support grant was not found in your organization.',
    code: 'support-grant-not-found',
  });
}

function grantNotActive(): ConflictException {
  return new ConflictException({
    title: "Couldn't revoke support access",
    status: 409,
    detail: 'This grant has already ended, so there is nothing to revoke.',
    code: 'support-grant-not-active',
  });
}

function toGrant(row: GrantRow, now: Date): SupportGrant {
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    readOnly: row.readOnly,
    reason: row.reason,
    createdAt: row.createdAt,
    status: supportGrantStatus(row, now),
    grantedBy: row.grantedBy,
    revokedBy: row.revokedBy,
  };
}
