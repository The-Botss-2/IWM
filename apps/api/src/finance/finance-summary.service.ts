import { Injectable } from '@nestjs/common';
import type { FinanceSummary, FinanceSummaryQuery } from '@botss/shared-types';
import { Prisma } from '@botss/database';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { isSupportRequest } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { readFinanceSummary, storeFinanceSummary } from './finance-summary-cache';
import { D, LIVE_PAYMENT, money, requireWorkspace } from './serialize';

@Injectable()
export class FinanceSummaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Served from a short Redis cache when one is current (see
   * finance-summary-cache.ts for the epoch invalidation). The cache is an
   * optimization only: with Redis down or slow this computes, as before.
   */
  async summary(
    scope: UserScope,
    q: FinanceSummaryQuery,
  ): Promise<FinanceSummary> {
    const workspaceId = requireWorkspace(scope);
    // Read only support session: salaries are payroll data, which support
    // never sees, so they are left out of every expense figure. Computed
    // fresh and never cached, so the two versions never mix.
    if (isSupportRequest()) return this.compute(workspaceId, q, { excludeSalary: true });
    const cached = await readFinanceSummary(this.redis, workspaceId, q);
    if (cached?.hit) return cached.hit;
    const fresh = await this.compute(workspaceId, q);
    if (cached) storeFinanceSummary(this.redis, workspaceId, q, cached.epoch, fresh);
    return fresh;
  }

  private async compute(
    workspaceId: string,
    q: FinanceSummaryQuery,
    opts: { excludeSalary?: boolean } = {},
  ): Promise<FinanceSummary> {
    const excludeSalary = opts.excludeSalary === true;
    // Scope filters. A contract-level filter has to reach Payment through the
    // relation, since a payment carries no projectId of its own.
    const contractFilter: Record<string, unknown> = {};
    if (q.projectId) contractFilter['projectId'] = q.projectId;
    if (q.clientId) contractFilter['clientId'] = q.clientId;
    const hasContractFilter = Object.keys(contractFilter).length > 0;

    // NOTE: `Payment` is not soft-deleted, so LIVE_PAYMENT (voidedAt: null)
    // must be spread into EVERY aggregate by hand.
    //
    // NOTE 2: payments attached to a soft-deleted contract are deliberately
    // still counted. The money did arrive; hiding it would make the dashboard
    // disagree with the bank. The next reader will assume that is a bug, so:
    // it is not.
    const paymentWhere: Record<string, unknown> = {
      workspaceId,
      ...LIVE_PAYMENT,
      paidAt: { gte: q.from, lte: q.to },
      ...(hasContractFilter ? { contract: contractFilter } : {}),
    };

    const expenseWhere: Record<string, unknown> = {
      workspaceId,
      incurredAt: { gte: q.from, lte: q.to },
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(excludeSalary ? { category: { not: 'SALARY' } } : {}),
    };

    const contractWhere: Record<string, unknown> = {
      workspaceId,
      ...contractFilter,
    };

    // Every stage below is independent of the others, so they all run at
    // once. The one dependent read (source names for `bySource`) chains off
    // its own groupBy instead of waiting for the whole batch.
    const bySourceWithNames = this.prisma.client.payment
      .groupBy({
        by: ['paymentSourceId'],
        where: paymentWhere,
        _sum: { baseAmount: true },
        _count: true,
      })
      .then(async (rows) => {
        // Attach source names with one follow-up read rather than a raw
        // join, so the soft-delete-extended client stays in play.
        const sourceIds = rows
          .map((r) => r.paymentSourceId)
          .filter((id): id is string => id != null);
        const sources = sourceIds.length
          ? await this.prisma.client.paymentSource.findMany({
              where: { id: { in: sourceIds } },
              select: { id: true, name: true, kind: true },
            })
          : [];
        return { rows, sourceById: new Map(sources.map((s) => [s.id, s])) };
      });

    const [
      baseCurrency,
      received,
      bySource,
      byRegionRaw,
      byCurrencyRaw,
      spent,
      byCategoryRaw,
      byStatusRaw,
      contracted,
      awaitingPaymentBase,
      outstanding,
      overdue,
      monthly,
      topClients,
      outstandingByCurrency,
    ] = await Promise.all([
      this.baseCurrency(workspaceId),
      // Hits @@index([workspaceId, paidAt]).
      this.prisma.client.payment.aggregate({
        where: paymentWhere,
        _sum: { baseAmount: true, receivedAmount: true, feeAmount: true },
        _count: true,
      }),
      bySourceWithNames,
      this.prisma.client.payment.groupBy({
        by: ['region'],
        where: paymentWhere,
        _sum: { baseAmount: true },
        _count: true,
      }),
      this.prisma.client.payment.groupBy({
        by: ['currency'],
        where: paymentWhere,
        _sum: { amount: true, baseAmount: true },
      }),
      this.prisma.client.expense.aggregate({
        where: expenseWhere,
        _sum: { baseAmount: true },
        _count: true,
      }),
      this.prisma.client.expense.groupBy({
        by: ['category'],
        where: expenseWhere,
        _sum: { baseAmount: true },
      }),
      this.prisma.client.contract.groupBy({
        by: ['paymentStatus'],
        where: { ...contractWhere, status: 'ACTIVE' },
        _count: true,
      }),
      this.prisma.client.contract.aggregate({
        where: { ...contractWhere, status: 'ACTIVE' },
        _sum: { baseTotalValue: true },
      }),
      this.awaitingBase(workspaceId, contractFilter),
      this.outstandingBase(workspaceId, contractFilter),
      this.overdueBase(workspaceId, contractFilter),
      this.monthly(workspaceId, q, excludeSalary),
      this.topClients(workspaceId, q, contractFilter),
      this.outstandingByCurrency(workspaceId, contractFilter),
    ]);
    const { rows: bySourceRaw, sourceById } = bySource;

    const receivedBase = new D(received._sum.baseAmount ?? 0);
    const spentBase = new D(spent._sum.baseAmount ?? 0);

    // Gross = net + fees. Reconstructed rather than stored, because storing it
    // would be a fourth amount column that could drift out of step with the
    // other three.
    //
    // Caveat: fees are denominated in each payment's `receivedCurrency`, so
    // summing them raw is only exact when the period is single-currency. It is
    // reported as a cost SIGNAL and never feeds another figure - `receivedBase`
    // is computed from per-row `baseAmount` and stays exact.
    const feeTotal = new D(received._sum.feeAmount ?? 0);

    const statusCounts = { NOT_PAID: 0, PARTIAL: 0, PAID: 0 };
    for (const row of byStatusRaw) {
      statusCounts[row.paymentStatus as keyof typeof statusCounts] = row._count;
    }

    return {
      baseCurrency,
      range: { from: q.from, to: q.to },

      receivedBase: money(receivedBase),
      receivedGrossBase: money(receivedBase.plus(feeTotal)),
      paymentCount: received._count,

      spentBase: money(spentBase),
      expenseCount: spent._count,
      netProfitBase: money(receivedBase.minus(spentBase)),

      outstandingBase: money(outstanding),
      overdueBase: money(overdue),
      contractedBase: money(contracted._sum.baseTotalValue ?? 0),
      awaitingPaymentBase: money(awaitingPaymentBase),

      byStatus: statusCounts,
      bySource: bySourceRaw.map((r) => {
        const s = r.paymentSourceId ? sourceById.get(r.paymentSourceId) : undefined;
        return {
          paymentSourceId: r.paymentSourceId,
          name: s?.name ?? 'Unattributed',
          kind: s?.kind ?? 'OTHER',
          amountBase: money(r._sum.baseAmount ?? 0),
          count: r._count,
        };
      }),
      byRegion: byRegionRaw.map((r) => ({
        region: r.region,
        amountBase: money(r._sum.baseAmount ?? 0),
        count: r._count,
      })),
      byCurrency: byCurrencyRaw.map((r) => ({
        currency: r.currency,
        amount: money(r._sum.amount ?? 0),
        amountBase: money(r._sum.baseAmount ?? 0),
      })),
      byExpenseCategory: byCategoryRaw.map((r) => ({
        category: r.category,
        amountBase: money(r._sum.baseAmount ?? 0),
      })),
      monthly,
      topClients,
      outstandingByCurrency,
    };
  }

  private async baseCurrency(workspaceId: string): Promise<string> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organization: { select: { baseCurrency: true } } },
    });
    return ws?.organization?.baseCurrency ?? 'PKR';
  }

  /**
   * Outstanding needs `(totalValue - amountPaid) * fxRateToBase`, which is an
   * expression rather than a column, so Prisma aggregate cannot express it.
   *
   * `prisma.raw` is the BARE client with no soft-delete extension, so the
   * `"deletedAt" IS NULL` below is manual and mandatory.
   */
  private async outstandingBase(
    workspaceId: string,
    filter: Record<string, unknown>,
  ) {
    const rows = await this.prisma.raw.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(("totalValue" - "amountPaid") * "fxRateToBase"), 0) AS total
      FROM "Contract"
      WHERE "workspaceId" = ${workspaceId}
        AND "status" = 'ACTIVE'
        AND "deletedAt" IS NULL
        AND ("totalValue" - "amountPaid") > 0
        AND (${(filter['projectId'] as string) ?? null}::text IS NULL OR "projectId" = ${(filter['projectId'] as string) ?? null})
        AND (${(filter['clientId'] as string) ?? null}::text IS NULL OR "clientId" = ${(filter['clientId'] as string) ?? null})
    `;
    return new D(rows[0]?.total ?? 0);
  }

  /**
   * Delivered milestones that are not yet fully paid, at each contract's
   * booked rate: SUM((amount - amountPaid) * fxRateToBase). Postgres numeric
   * math is exact (scale 2 minus scale 2, times scale 8 = scale 10), so this
   * equals the row-by-row Decimal sum it replaced whenever that sum fit
   * Decimal's 20 significant digits - any total under 10^10 in base currency.
   *
   * `ContractMilestone` is not soft-deleted; its contract is, and `prisma.raw`
   * has no soft-delete extension, so `c."deletedAt" IS NULL` stays manual.
   */
  private async awaitingBase(
    workspaceId: string,
    filter: Record<string, unknown>,
  ) {
    const projectId = (filter['projectId'] as string) ?? null;
    const clientId = (filter['clientId'] as string) ?? null;
    const rows = await this.prisma.raw.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM((m."amount" - m."amountPaid") * c."fxRateToBase"), 0) AS total
      FROM "ContractMilestone" m
      JOIN "Contract" c ON c."id" = m."contractId"
      WHERE c."workspaceId" = ${workspaceId}
        AND c."deletedAt" IS NULL
        AND c."status" <> 'CANCELLED'
        AND m."status" = 'DELIVERED'
        AND m."paymentStatus" IN ('NOT_PAID', 'PARTIAL')
        AND (${projectId}::text IS NULL OR c."projectId" = ${projectId})
        AND (${clientId}::text IS NULL OR c."clientId" = ${clientId})
    `;
    return new D(rows[0]?.total ?? 0);
  }

  /** Milestones past their due date that are not fully paid. */
  private async overdueBase(
    workspaceId: string,
    filter: Record<string, unknown>,
  ) {
    const rows = await this.prisma.raw.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM((m."amount" - m."amountPaid") * c."fxRateToBase"), 0) AS total
      FROM "ContractMilestone" m
      JOIN "Contract" c ON c."id" = m."contractId"
      WHERE c."workspaceId" = ${workspaceId}
        AND c."deletedAt" IS NULL
        AND c."status" = 'ACTIVE'
        AND m."status" <> 'CANCELLED'
        AND m."paymentStatus" <> 'PAID'
        AND m."dueDate" IS NOT NULL
        AND m."dueDate" < NOW()
        AND (${(filter['projectId'] as string) ?? null}::text IS NULL OR c."projectId" = ${(filter['projectId'] as string) ?? null})
        AND (${(filter['clientId'] as string) ?? null}::text IS NULL OR c."clientId" = ${(filter['clientId'] as string) ?? null})
    `;
    return new D(rows[0]?.total ?? 0);
  }

  /** Trailing 12 months of in vs out. Prisma groupBy cannot date_trunc. */
  private async monthly(workspaceId: string, q: FinanceSummaryQuery, excludeSalary = false) {
    const since = new Date(q.to);
    since.setMonth(since.getMonth() - 11);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const [inRows, outRows] = await Promise.all([
      this.prisma.raw.$queryRaw<Array<{ month: string; total: Prisma.Decimal }>>`
        SELECT to_char(date_trunc('month', "paidAt"), 'YYYY-MM') AS month,
               COALESCE(SUM("baseAmount"), 0) AS total
        FROM "Payment"
        WHERE "workspaceId" = ${workspaceId}
          AND "voidedAt" IS NULL
          AND "paidAt" >= ${since}
        GROUP BY 1 ORDER BY 1
      `,
      this.prisma.raw.$queryRaw<Array<{ month: string; total: Prisma.Decimal }>>`
        SELECT to_char(date_trunc('month', "incurredAt"), 'YYYY-MM') AS month,
               COALESCE(SUM("baseAmount"), 0) AS total
        FROM "Expense"
        WHERE "workspaceId" = ${workspaceId}
          AND "deletedAt" IS NULL
          AND "incurredAt" >= ${since}
          ${excludeSalary ? Prisma.sql`AND "category"::text <> 'SALARY'` : Prisma.empty}
        GROUP BY 1 ORDER BY 1
      `,
    ]);

    const inBy = new Map(inRows.map((r) => [r.month, r.total]));
    const outBy = new Map(outRows.map((r) => [r.month, r.total]));

    // Emit a dense series so the chart has no gaps for quiet months.
    const out: Array<{ month: string; receivedBase: string; spentBase: string }> = [];
    const cursor = new Date(since);
    for (let i = 0; i < 12; i += 1) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      out.push({
        month: key,
        receivedBase: money(inBy.get(key) ?? 0),
        spentBase: money(outBy.get(key) ?? 0),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return out;
  }

  private async topClients(
    workspaceId: string,
    q: FinanceSummaryQuery,
    filter: Record<string, unknown>,
  ) {
    const projectId = (filter['projectId'] as string) ?? null;
    const clientId = (filter['clientId'] as string) ?? null;
    const rows = await this.prisma.raw.$queryRaw<
      Array<{ clientId: string; name: string; total: Prisma.Decimal }>
    >`
      SELECT c."clientId" AS "clientId", cl."name" AS name,
             COALESCE(SUM(p."baseAmount"), 0) AS total
      FROM "Payment" p
      JOIN "Contract" c ON c."id" = p."contractId"
      JOIN "Client" cl ON cl."id" = c."clientId"
      WHERE p."workspaceId" = ${workspaceId}
        AND p."voidedAt" IS NULL
        AND p."paidAt" >= ${q.from}
        AND p."paidAt" <= ${q.to}
        AND (${projectId}::text IS NULL OR c."projectId" = ${projectId})
        AND (${clientId}::text IS NULL OR c."clientId" = ${clientId})
      GROUP BY 1, 2
      ORDER BY 3 DESC
      LIMIT 5
    `;
    return rows.map((r) => ({
      clientId: r.clientId,
      name: r.name,
      amountBase: money(r.total),
    }));
  }

  /**
   * Exact per-currency outstanding with NO FX applied. The base figure above
   * is a booked-rate estimate; this is the number to quote a client.
   */
  private async outstandingByCurrency(
    workspaceId: string,
    filter: Record<string, unknown>,
  ) {
    const rows = await this.prisma.client.contract.groupBy({
      by: ['currency'],
      where: { workspaceId, status: 'ACTIVE', ...filter },
      _sum: { totalValue: true, amountPaid: true },
    });
    return rows
      .map((r) => ({
        currency: r.currency,
        amount: new D(r._sum.totalValue ?? 0).minus(new D(r._sum.amountPaid ?? 0)),
      }))
      .filter((r) => r.amount.gt(0))
      .map((r) => ({ currency: r.currency, amount: money(r.amount) }));
  }
}
