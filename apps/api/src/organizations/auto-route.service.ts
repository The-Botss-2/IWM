import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Resolves which Organization a user belongs to based on the domain of
 * their email address. Called from the user-bootstrap path so a fresh
 * signup whose email domain an organization has claimed (its
 * `emailDomain`) lands inside that organization.
 *
 * IMPORTANT: this routing controls ORG MEMBERSHIP ONLY. It does not
 * touch `systemRole` - a brand-new signup is just a regular member
 * until an existing admin explicitly promotes them.
 */
@Injectable()
export class OrganizationAutoRouteService {
  private readonly logger = new Logger(OrganizationAutoRouteService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Look up an Organization whose `emailDomain` matches the suffix of
   * the given email. Returns the org id or null if no rule matches.
   */
  async resolveOrgIdForEmail(email: string): Promise<string | null> {
    const domain = email.split('@')[1]?.toLowerCase() ?? null;
    if (!domain) return null;
    const org = await this.prisma.client.organization.findFirst({
      where: { emailDomain: domain, deletedAt: null, isActive: true },
      select: { id: true },
    });
    return org?.id ?? null;
  }

  /**
   * Attach a user to the org their email implies, if any. Idempotent -
   * skips when the user already has an organizationId. Designed to be
   * called once at user-bootstrap time; never overwrites an existing
   * assignment (admin-driven moves win).
   */
  async attachOnBootstrap(userId: string, email: string): Promise<void> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { organizationId: true, accountType: true },
    });
    if (!user) return;
    if (user.organizationId) return;
    // Client-portal accounts have no org on purpose; a matching email domain
    // must never turn one into a member of that org.
    if (user.accountType === 'CLIENT') return;
    const orgId = await this.resolveOrgIdForEmail(email);
    if (!orgId) return;
    await this.prisma.client.user.update({
      where: { id: userId },
      data: { organizationId: orgId },
    });
    this.logger.log(`Auto-routed user ${userId} to organization ${orgId}.`);
  }
}
