import { Injectable } from '@nestjs/common';
import type { SalesAccess } from '@botss/shared-types';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SalesAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Answer "should this user be shown Leads / Clients?" for the active
   * workspace. Full sales access short-circuits; otherwise a section unlocks as
   * soon as one record there is assigned to the user.
   *
   * `findFirst` rather than `count` - we only need existence, and it lets
   * Postgres stop at the first matching row on the `assigneeId` index.
   */
  async forActor(actor: SalesActor): Promise<SalesAccess> {
    if (actor.fullAccess) {
      return { fullAccess: true, leads: true, clients: true };
    }
    const where = { workspaceId: actor.workspaceId, assigneeId: actor.userId };
    const [lead, client] = await Promise.all([
      actor.fullLeads
        ? Promise.resolve({ id: 'all' })
        : this.prisma.client.lead.findFirst({ where, select: { id: true } }),
      actor.fullClients
        ? Promise.resolve({ id: 'all' })
        : this.prisma.client.client.findFirst({ where, select: { id: true } }),
    ]);
    // Finance roles read every client (see clients/client-visibility.ts), so
    // the Clients section is open to them even with nothing assigned.
    return {
      fullAccess: false,
      leads: lead !== null,
      clients: actor.financeAccess || client !== null,
    };
  }
}
