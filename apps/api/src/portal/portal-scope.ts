import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ClientContactRole } from '@botss/shared-types';

import { PrismaService } from '../prisma/prisma.service';

/**
 * The single source of truth for what a client-portal person may reach.
 * Every portal query starts here, the same way internal project reads start
 * from `common/project-access.ts`.
 *
 * A contact is live only while the contact row, the person's account, the
 * client, the client's workspace and that workspace's organization are all
 * live. The soft-delete extension filters only TOP-LEVEL queries, so every
 * nested `deletedAt` / `isActive` below is written out by hand on purpose.
 */
export interface PortalContact {
  contactId: string;
  role: ClientContactRole;
  clientId: string;
  clientName: string;
  /** The client's workspace. Every portal query is pinned to it, because
   *  `Project.clientId` was historically not validated against it. */
  workspaceId: string;
  organizationId: string;
}

export function livePortalContactWhere(userId: string) {
  return {
    userId,
    deletedAt: null,
    user: { deletedAt: null, accountType: 'CLIENT' as const },
    client: {
      deletedAt: null,
      workspace: {
        deletedAt: null,
        isActive: true,
        organization: { deletedAt: null, isActive: true },
      },
    },
  };
}

const CONTACT_SELECT = {
  id: true,
  role: true,
  client: {
    select: {
      id: true,
      name: true,
      workspaceId: true,
      workspace: { select: { organizationId: true } },
    },
  },
} as const;

type ContactRow = {
  id: string;
  role: ClientContactRole;
  client: { id: string; name: string; workspaceId: string; workspace: { organizationId: string } };
};

function toPortalContact(row: ContactRow): PortalContact {
  return {
    contactId: row.id,
    role: row.role,
    clientId: row.client.id,
    clientName: row.client.name,
    workspaceId: row.client.workspaceId,
    organizationId: row.client.workspace.organizationId,
  };
}

@Injectable()
export class PortalScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every live contact of this person, oldest first. */
  async contacts(userId: string): Promise<PortalContact[]> {
    const rows = await this.prisma.client.clientContact.findMany({
      where: livePortalContactWhere(userId),
      select: CONTACT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toPortalContact);
  }

  /**
   * The caller's contact for one client. 404 (not 403) when there is none,
   * so a portal person cannot probe which client ids exist. `billing`
   * additionally requires the main contact.
   */
  async require(
    userId: string,
    clientId: string,
    opts: { billing?: boolean } = {},
  ): Promise<PortalContact> {
    const row = await this.prisma.client.clientContact.findFirst({
      where: { ...livePortalContactWhere(userId), clientId },
      select: CONTACT_SELECT,
    });
    if (!row) {
      throw new NotFoundException({ title: 'Not found', status: 404 });
    }
    if (opts.billing && row.role !== 'PRIMARY') {
      throw new ForbiddenException({
        title: 'Billing is for the main contact',
        status: 403,
        detail: 'Ask your main contact for invoices and contracts.',
        code: 'portal-billing-primary-only',
      });
    }
    return toPortalContact(row);
  }
}
