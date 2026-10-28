import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { hashPassword, verifyPassword } from '@botss/auth';
import { portalMeSchema, type PortalChangePasswordInput, type PortalMe } from '@botss/shared-types';

import type { AuthedUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { agencyBranding } from './agency';
import { PortalScopeService, type PortalContact } from './portal-scope';

const LAST_SEEN_EVERY_MS = 60 * 60 * 1000;

/** The signed-in client person: who they are and which clients they reach. */
@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PortalScopeService,
  ) {}

  async me(user: AuthedUser): Promise<PortalMe> {
    const contacts = await this.scope.contacts(user.id);
    const agencies = new Map<string, { name: string; logoUrl: string | null }>();
    for (const orgId of new Set(contacts.map((c) => c.organizationId))) {
      agencies.set(orgId, await agencyBranding(this.prisma, orgId));
    }
    void this.touchLastSeen(contacts);
    return portalMeSchema.parse({
      user: { id: user.id, name: user.name, email: user.email },
      clients: contacts.map((c) => ({
        id: c.clientId,
        name: c.clientName,
        role: c.role,
        canSeeBilling: c.role === 'PRIMARY',
        agency: agencies.get(c.organizationId) ?? { name: 'Client portal', logoUrl: null },
      })),
    });
  }

  /**
   * Client people rotate their own password here. Staff never can: their CRM
   * password is kept in step with webmail by the admin Users panel, which is
   * also why Better Auth's own change-password route is closed.
   */
  async changePassword(
    user: AuthedUser,
    sessionId: string | undefined,
    input: PortalChangePasswordInput,
  ): Promise<void> {
    const account = await this.prisma.client.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
      select: { id: true, password: true },
    });
    if (!account?.password || !verifyPassword(account.password, input.currentPassword)) {
      throw new BadRequestException({
        title: 'Current password is incorrect',
        status: 400,
        code: 'wrong-password',
      });
    }
    await this.prisma.client.$transaction([
      this.prisma.client.account.update({
        where: { id: account.id },
        data: { password: hashPassword(input.newPassword) },
      }),
      // Sign out every other device; the one making the change stays in.
      this.prisma.client.session.deleteMany({
        where: { userId: user.id, ...(sessionId ? { id: { not: sessionId } } : {}) },
      }),
    ]);
  }

  private async touchLastSeen(contacts: PortalContact[]): Promise<void> {
    if (contacts.length === 0) return;
    const now = new Date();
    try {
      await this.prisma.client.clientContact.updateMany({
        where: {
          id: { in: contacts.map((c) => c.contactId) },
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: new Date(now.getTime() - LAST_SEEN_EVERY_MS) } },
          ],
        },
        data: { lastSeenAt: now },
      });
    } catch (err) {
      this.logger.warn(`lastSeenAt bump failed: ${(err as Error).message}`);
    }
  }
}
