import { ForbiddenException, Injectable } from '@nestjs/common';
import { clientBillingSummarySchema, type ClientBillingSummary } from '@botss/shared-types';

import {
  COUNTED_CONTRACT_STATUSES,
  ISSUED_INVOICE_EXCLUDED,
  summarizeClientBilling,
} from '../clients/client-hub-rules';
import { requireVisibleClient } from '../clients/client-visibility';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { clientContractWhere, clientPaymentWhere } from './client-finance-where';
import { LIVE_PAYMENT } from './serialize';

/**
 * The summary on top of a client's Billing tab: per-currency invoice,
 * contract and received totals. Finance roles only.
 */
@Injectable()
export class ClientBillingService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(actor: SalesActor, clientId: string): Promise<ClientBillingSummary> {
    // Explicit, on top of the route's `read Invoice` ability: money is an
    // org-level concern and must not depend on the CASL layering alone.
    if (!actor.financeAccess) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only finance roles can see a client billing summary.',
        code: 'insufficient_permissions',
      });
    }
    const client = await requireVisibleClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({
        where,
        select: {
          id: true,
          workspaceId: true,
        },
      }),
    );
    const workspaceId = client.workspaceId;

    const [invoices, contracts, payments] = await Promise.all([
      this.prisma.client.invoice.findMany({
        where: {
          workspaceId,
          clientId: client.id,
          deletedAt: null,
          status: { notIn: [...ISSUED_INVOICE_EXCLUDED] },
        },
        select: { currency: true, status: true, total: true, amountPaid: true, dueAt: true },
      }),
      this.prisma.client.contract.findMany({
        where: {
          AND: [
            { workspaceId, deletedAt: null, status: { in: [...COUNTED_CONTRACT_STATUSES] } },
            clientContractWhere(client.id),
          ],
        },
        select: { currency: true, status: true, totalValue: true, amountPaid: true },
      }),
      this.prisma.client.payment.groupBy({
        by: ['currency'],
        where: { AND: [{ workspaceId, ...LIVE_PAYMENT }, clientPaymentWhere(client.id)] },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);

    const result = summarizeClientBilling({
      invoices,
      contracts,
      payments: payments.map((p) => ({
        currency: p.currency,
        amount: p._sum.amount,
        count: p._count._all,
      })),
    });
    return clientBillingSummarySchema.parse({ clientId: client.id, ...result });
  }
}
