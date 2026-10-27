import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  Payment,
  PaymentWithSource,
  UpdatePaymentInput,
  VoidPaymentInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { bumpFinanceSummary } from './finance-summary-cache';
import { clientPaymentWhere } from './client-finance-where';
import { paymentSourceForWorkspace } from './payment-source-ref';
import { recalcContract, type TxClient } from './contract-totals';
import {
  D,
  bookRate,
  fxRateRequired,
  hasRate,
  LIVE_PAYMENT,
  money,
  rate,
  requireWorkspace,
  round2,
  toDecimal,
} from './serialize';

const REFS_INCLUDE = {
  paymentSource: { select: { id: true, name: true, kind: true } },
  recordedBy: { select: { id: true, name: true } },
  contract: { select: { id: true, title: true } },
  milestone: { select: { id: true, title: true } },
} as const;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma row shapes vary by include
  private base(p: any): Payment {
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      invoiceId: p.invoiceId,
      contractId: p.contractId,
      milestoneId: p.milestoneId,
      paymentSourceId: p.paymentSourceId,
      amount: money(p.amount),
      currency: p.currency,
      receivedAmount: money(p.receivedAmount),
      receivedCurrency: p.receivedCurrency,
      feeAmount: money(p.feeAmount),
      fxRate: rate(p.fxRate),
      baseAmount: money(p.baseAmount),
      region: p.region,
      reference: p.reference,
      paidAt: p.paidAt,
      notes: p.notes,
      recordedById: p.recordedById,
      voidedAt: p.voidedAt,
      voidReason: p.voidReason,
      voidedById: p.voidedById,
      method: p.method,
      externalId: p.externalId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  private withRefs(p: any): PaymentWithSource {
    return {
      ...this.base(p),
      paymentSource: p.paymentSource ?? null,
      recordedBy: p.recordedBy ?? null,
      contract: p.contract ?? null,
      milestone: p.milestone ?? null,
    };
  }

  /** The organisation's reporting currency, reached via the workspace. */
  private async baseCurrency(workspaceId: string): Promise<string> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organization: { select: { baseCurrency: true } } },
    });
    return ws?.organization?.baseCurrency ?? 'PKR';
  }

  /**
   * Resolve the three amount pairs into storable columns.
   *
   * Defaults collapse the common case ("client paid exactly what we billed, no
   * fee, same currency") down to a single `amount` field on the form.
   */
  private computeAmounts(
    input: {
      amount?: string | number;
      currency: string;
      receivedAmount?: string | number;
      receivedCurrency?: string;
      feeAmount?: string | number;
      fxRate?: string | number;
    },
    baseCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prior row when updating
    prior?: any,
  ) {
    const amount = round2(
      input.amount !== undefined ? toDecimal(input.amount, 0) : new D(prior?.amount ?? 0),
    );
    const receivedCurrency =
      input.receivedCurrency ?? prior?.receivedCurrency ?? input.currency;
    const receivedAmount = round2(
      input.receivedAmount !== undefined
        ? toDecimal(input.receivedAmount, 0)
        : prior
          ? new D(prior.receivedAmount)
          : amount,
    );
    const feeAmount = round2(
      input.feeAmount !== undefined
        ? toDecimal(input.feeAmount, 0)
        : new D(prior?.feeAmount ?? 0),
    );

    // A rate of anything but 1 between a currency and itself is nonsense, and
    // silently wrong in a way nobody notices until the dashboard is off. Force
    // it rather than trusting the client.
    const fxRate =
      receivedCurrency === baseCurrency
        ? new D(1)
        : hasRate(input.fxRate)
          ? bookRate(input.fxRate)
          : new D(prior?.fxRate ?? 1);

    if (fxRate.lte(0)) {
      throw new BadRequestException({
        title: 'Invalid exchange rate',
        status: 400,
        detail: 'The exchange rate must be greater than zero.',
        code: 'invalid_fx_rate',
      });
    }
    if (feeAmount.gt(receivedAmount)) {
      throw new BadRequestException({
        title: 'Fee exceeds amount',
        status: 400,
        detail: 'The platform fee cannot be larger than the amount received.',
        code: 'fee_exceeds_amount',
      });
    }

    // Revenue is NET of fees. Contracts advance on gross (`amount`); the
    // dashboard sums `baseAmount`. The difference is the platform + FX cost.
    const baseAmount = round2(receivedAmount.minus(feeAmount).times(fxRate));

    return { amount, receivedAmount, receivedCurrency, feeAmount, fxRate, baseAmount };
  }

  /**
   * Validate the contract / milestone / invoice a payment claims to settle and
   * return the resolved links. Shared by create and by the invoice module.
   */
  private async resolveTargets(
    tx: TxClient,
    workspaceId: string,
    input: { contractId?: string; milestoneId?: string; invoiceId?: string },
  ): Promise<{ contractId: string | null; milestoneId: string | null; invoiceId: string | null; currency: string }> {
    let contractId = input.contractId ?? null;
    let currency: string | null = null;

    if (input.invoiceId) {
      const inv = await tx.invoice.findFirst({
        where: { id: input.invoiceId, workspaceId },
        select: { id: true, currency: true, contractId: true },
      });
      if (!inv) {
        throw new BadRequestException({
          title: 'Invalid invoice',
          status: 400,
          detail: 'Invoice not found in this workspace.',
          code: 'invalid_invoice',
        });
      }
      currency = inv.currency;
      // An invoice raised against a contract carries its payments through to
      // that contract, so the contract advances without a second entry.
      if (!contractId && inv.contractId) contractId = inv.contractId;
    }

    let milestoneId = input.milestoneId ?? null;

    if (contractId) {
      const contract = await tx.contract.findFirst({
        where: { id: contractId, workspaceId, deletedAt: null },
        select: { id: true, currency: true },
      });
      if (!contract) {
        throw new BadRequestException({
          title: 'Invalid contract',
          status: 400,
          detail: 'Contract not found in this workspace.',
          code: 'invalid_contract',
        });
      }
      currency = contract.currency;

      if (milestoneId) {
        const m = await tx.contractMilestone.findUnique({
          where: { id: milestoneId },
          select: { id: true, contractId: true },
        });
        if (!m || m.contractId !== contractId) {
          throw new BadRequestException({
            title: 'Invalid milestone',
            status: 400,
            detail: 'That milestone does not belong to this contract.',
            code: 'milestone_contract_mismatch',
          });
        }
      }
    } else if (milestoneId) {
      // A milestone with no contract on the input still pins the contract.
      const m = await tx.contractMilestone.findUnique({
        where: { id: milestoneId },
        select: { contractId: true, contract: { select: { workspaceId: true, currency: true } } },
      });
      if (!m || m.contract.workspaceId !== workspaceId) {
        throw new BadRequestException({
          title: 'Invalid milestone',
          status: 400,
          detail: 'Milestone not found in this workspace.',
          code: 'invalid_milestone',
        });
      }
      contractId = m.contractId;
      currency = m.contract.currency;
    }

    if (!contractId && !input.invoiceId) {
      throw new BadRequestException({
        title: 'Nothing to settle',
        status: 400,
        detail: 'A payment must reference a contract, milestone, or invoice.',
        code: 'payment_target_required',
      });
    }

    return {
      contractId,
      milestoneId,
      invoiceId: input.invoiceId ?? null,
      currency: currency ?? 'USD',
    };
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async list(scope: UserScope, q: ListPaymentsQuery) {
    const workspaceId = requireWorkspace(scope);
    const where: Record<string, unknown> = { workspaceId };
    if (!q.includeVoided) Object.assign(where, LIVE_PAYMENT);
    if (q.contractId) where['contractId'] = q.contractId;
    if (q.milestoneId) where['milestoneId'] = q.milestoneId;
    if (q.invoiceId) where['invoiceId'] = q.invoiceId;
    if (q.paymentSourceId) where['paymentSourceId'] = q.paymentSourceId;
    if (q.region) where['region'] = q.region;
    if (q.currency) where['currency'] = q.currency;
    if (q.projectId) where['contract'] = { projectId: q.projectId };
    // Relation filters that need their own OR go in here, so they never
    // clobber the free-text search OR below.
    const and: Record<string, unknown>[] = [];
    if (q.clientId) and.push(clientPaymentWhere(q.clientId));
    if (q.paidFrom || q.paidTo) {
      where['paidAt'] = {
        ...(q.paidFrom ? { gte: q.paidFrom } : {}),
        ...(q.paidTo ? { lte: q.paidTo } : {}),
      };
    }
    if (q.q) {
      where['OR'] = [
        { reference: { contains: q.q, mode: 'insensitive' } },
        { notes: { contains: q.q, mode: 'insensitive' } },
        { contract: { title: { contains: q.q, mode: 'insensitive' } } },
      ];
    }
    if (and.length > 0) where['AND'] = and;

    const [items, total] = await Promise.all([
      this.prisma.client.payment.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: REFS_INCLUDE,
      }),
      this.prisma.client.payment.count({ where }),
    ]);

    return {
      items: items.map((p) => this.withRefs(p)),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async create(
    scope: UserScope,
    input: CreatePaymentInput,
  ): Promise<PaymentWithSource> {
    const workspaceId = requireWorkspace(scope);
    const baseCurrency = await this.baseCurrency(workspaceId);
    // Same organization as the workspace, or 400 invalid_payment_source.
    const src = input.paymentSourceId
      ? await paymentSourceForWorkspace(this.prisma, workspaceId, input.paymentSourceId)
      : null;

    const created = await this.prisma.client.$transaction(async (tx) => {
      const targets = await this.resolveTargets(tx, workspaceId, input);

      // A payment settles a contract in THAT contract's currency. Accepting a
      // PKR payment against a USD contract would make `amountPaid` a sum of
      // two different units, and `amountPaid === totalValue` would stop
      // meaning anything. What actually landed in the bank is recorded
      // separately as receivedAmount / receivedCurrency.
      const currency = input.currency ?? targets.currency;
      if (currency !== targets.currency) {
        throw new BadRequestException({
          title: 'Currency mismatch',
          status: 400,
          detail: `This contract is billed in ${targets.currency}. Record the amount in ${targets.currency} and use "received" for what actually landed.`,
          code: 'currency_mismatch',
        });
      }

      let region = input.region;
      const paymentSourceId = input.paymentSourceId ?? null;
      // Null defaultRegion means "ask every time", so only fill the gap.
      if (!region && src?.defaultRegion) region = src.defaultRegion;

      // A foreign-currency payment needs a rate to base, or `baseAmount` (the
      // only figure dashboards sum) would book USD 1,000 as PKR 1,000. Fall
      // back to the linked contract's rate, as the contract payment form does;
      // with no contract there is nothing to fall back on.
      let fxRate = hasRate(input.fxRate) ? input.fxRate : undefined;
      const receivedCurrency = input.receivedCurrency ?? currency;
      if (fxRate === undefined && receivedCurrency !== baseCurrency) {
        const contract = targets.contractId
          ? await tx.contract.findUnique({
              where: { id: targets.contractId },
              select: { currency: true, fxRateToBase: true },
            })
          : null;
        if (!contract || contract.currency !== receivedCurrency) {
          throw fxRateRequired(baseCurrency, receivedCurrency, 'payment');
        }
        fxRate = contract.fxRateToBase.toString();
      }

      const amounts = this.computeAmounts({ ...input, currency, fxRate }, baseCurrency);

      const payment = await tx.payment.create({
        data: {
          workspaceId,
          contractId: targets.contractId,
          milestoneId: targets.milestoneId,
          invoiceId: targets.invoiceId,
          paymentSourceId,
          currency,
          region: region ?? 'LOCAL',
          reference: input.reference ?? null,
          paidAt: input.paidAt ?? new Date(),
          notes: input.notes ?? null,
          recordedById: scope.userId,
          ...amounts,
        },
        include: REFS_INCLUDE,
      });

      if (targets.contractId) await recalcContract(tx, targets.contractId);
      if (targets.invoiceId) await this.syncInvoiceTotals(tx, targets.invoiceId);

      return payment;
    });
    await bumpFinanceSummary(this.redis, workspaceId);

    void this.notifyFinance(workspaceId, scope.userId, created).catch(() => {});
    return this.withRefs(created);
  }

  async update(
    scope: UserScope,
    id: string,
    input: UpdatePaymentInput,
  ): Promise<PaymentWithSource> {
    const workspaceId = requireWorkspace(scope);
    const existing = await this.prisma.client.payment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Payment not found', status: 404 });
    }
    if (existing.voidedAt) {
      throw new BadRequestException({
        title: 'Payment is voided',
        status: 400,
        detail: 'A voided payment cannot be edited. Record a new one instead.',
        code: 'payment_voided',
      });
    }

    const baseCurrency = await this.baseCurrency(workspaceId);

    if (input.paymentSourceId) {
      await paymentSourceForWorkspace(this.prisma, workspaceId, input.paymentSourceId);
    }

    const updated = await this.prisma.client.$transaction(async (tx) => {
      // Re-parenting a payment between contracts would silently rewrite two
      // sets of totals, so only the milestone within the SAME contract moves.
      if (input.milestoneId !== undefined && input.milestoneId !== null) {
        const m = await tx.contractMilestone.findUnique({
          where: { id: input.milestoneId },
          select: { contractId: true },
        });
        if (!m || m.contractId !== existing.contractId) {
          throw new BadRequestException({
            title: 'Invalid milestone',
            status: 400,
            detail: 'That milestone does not belong to this payment’s contract.',
            code: 'milestone_contract_mismatch',
          });
        }
      }

      // Moving the received money to another non-base currency must come
      // with its rate: otherwise computeAmounts keeps the stored one (often
      // 1) and books the new currency as if it were the old.
      const receivedCurrency = input.receivedCurrency ?? existing.receivedCurrency;
      if (
        receivedCurrency !== existing.receivedCurrency &&
        receivedCurrency !== baseCurrency &&
        !hasRate(input.fxRate)
      ) {
        throw fxRateRequired(baseCurrency, receivedCurrency, 'payment');
      }

      const amounts = this.computeAmounts(
        { ...input, currency: existing.currency },
        baseCurrency,
        existing,
      );

      const data: Record<string, unknown> = { ...amounts };
      if (input.milestoneId !== undefined) data['milestoneId'] = input.milestoneId;
      if (input.paymentSourceId !== undefined) {
        data['paymentSourceId'] = input.paymentSourceId;
      }
      if (input.region !== undefined) data['region'] = input.region;
      if (input.reference !== undefined) data['reference'] = input.reference;
      if (input.paidAt !== undefined) data['paidAt'] = input.paidAt;
      if (input.notes !== undefined) data['notes'] = input.notes;

      const payment = await tx.payment.update({
        where: { id },
        data,
        include: REFS_INCLUDE,
      });
      if (existing.contractId) await recalcContract(tx, existing.contractId);
      if (existing.invoiceId) await this.syncInvoiceTotals(tx, existing.invoiceId);
      return payment;
    });
    await bumpFinanceSummary(this.redis, workspaceId);

    return this.withRefs(updated);
  }

  /**
   * Void, never delete. The row stays queryable so the audit trail survives;
   * every aggregate filters on `voidedAt: null`.
   */
  async void(
    scope: UserScope,
    id: string,
    input: VoidPaymentInput,
  ): Promise<PaymentWithSource> {
    const workspaceId = requireWorkspace(scope);
    const existing = await this.prisma.client.payment.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Payment not found', status: 404 });
    }
    if (existing.voidedAt) return this.withRefs(existing);

    const voided = await this.prisma.client.$transaction(async (tx) => {
      const payment = await tx.payment.update({
        where: { id },
        data: {
          voidedAt: new Date(),
          voidReason: input.reason,
          voidedById: scope.userId,
        },
        include: REFS_INCLUDE,
      });
      if (existing.contractId) await recalcContract(tx, existing.contractId);
      if (existing.invoiceId) await this.syncInvoiceTotals(tx, existing.invoiceId);
      return payment;
    });
    await bumpFinanceSummary(this.redis, workspaceId);

    return this.withRefs(voided);
  }

  /**
   * Keep `Invoice.amountPaid` / `status` in step when a payment moves.
   * Mirrors `recalcContract`: a full recompute from non-voided rows, never an
   * increment, so voiding walks the status back correctly.
   */
  private async syncInvoiceTotals(tx: TxClient, invoiceId: string): Promise<void> {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true, total: true, status: true },
    });
    if (!invoice) return;

    const agg = await tx.payment.aggregate({
      where: { invoiceId, voidedAt: null },
      _sum: { amount: true },
    });
    const paid = new D(agg._sum.amount ?? 0);
    const total = new D(invoice.total);

    // CANCELLED / REFUNDED are terminal states a human chose; money movement
    // must not drag them back into the paid flow.
    const terminal = invoice.status === 'CANCELLED' || invoice.status === 'REFUNDED';
    const status = terminal
      ? invoice.status
      : paid.lte(0)
        ? invoice.status === 'DRAFT'
          ? 'DRAFT'
          : 'SENT'
        : total.gt(0) && paid.gte(total)
          ? 'PAID'
          : 'PARTIALLY_PAID';

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { amountPaid: round2(paid), status },
    });
  }

  /** Fire-and-forget: a push failure must never roll back a recorded payment. */
  private async notifyFinance(
    workspaceId: string,
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- created row
    payment: any,
  ): Promise<void> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) return;
    const recipients = await this.prisma.client.user.findMany({
      where: {
        organizationId: ws.organizationId,
        systemRole: { in: ['ADMIN', 'SUPER_ADMIN', 'FINANCE'] },
      },
      select: { id: true },
    });
    const title = payment.contract?.title ?? 'Payment received';
    await this.notifications.emitMany(
      recipients.map((r) => r.id).filter((id) => id !== actorId),
      {
        actorId,
        type: 'PAYMENT_RECEIVED',
        title: 'Payment received',
        body: `${money(payment.amount)} ${payment.currency} – ${title}`,
        entityType: 'contract',
        entityId: payment.contractId ?? undefined,
        url: payment.contractId ? `/financials/${payment.contractId}` : '/financials',
      },
    );
  }
}
