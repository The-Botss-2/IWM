import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Contract,
  ContractListItem,
  ContractWithMilestones,
  CreateContractInput,
  ListContractsQuery,
  UpdateContractInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { bumpFinanceSummary } from './finance-summary-cache';
import { clientContractWhere } from './client-finance-where';
import { recalcContract } from './contract-totals';
import {
  bookRate,
  D,
  fxRateRequired,
  hasRate,
  money,
  rate,
  requireWorkspace,
  round2,
  toDecimal,
} from './serialize';

const MILESTONE_INCLUDE = {
  sprint: { select: { id: true, name: true, status: true } },
  tasks: {
    select: {
      task: { select: { id: true, title: true, status: true } },
    },
  },
} as const;

@Injectable()
export class ContractsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---------------------------------------------------------------------
  // Serialization. Decimal never crosses the wire - see ./serialize.
  // ---------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma row shapes vary by include
  private base(c: any): Contract {
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      projectId: c.projectId,
      clientId: c.clientId,
      createdById: c.createdById,
      title: c.title,
      billingModel: c.billingModel,
      status: c.status,
      currency: c.currency,
      totalValue: money(c.totalValue),
      amountPaid: money(c.amountPaid),
      paymentStatus: c.paymentStatus,
      fxRateToBase: rate(c.fxRateToBase),
      baseTotalValue: money(c.baseTotalValue),
      startDate: c.startDate,
      endDate: c.endDate,
      notes: c.notes,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      deletedAt: c.deletedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
  private milestone(m: any) {
    return {
      id: m.id,
      contractId: m.contractId,
      position: m.position,
      title: m.title,
      description: m.description,
      amount: money(m.amount),
      amountPaid: money(m.amountPaid),
      status: m.status,
      paymentStatus: m.paymentStatus,
      dueDate: m.dueDate,
      deliveredAt: m.deliveredAt,
      sprintId: m.sprintId,
      autoDeliver: m.autoDeliver,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      sprint: m.sprint ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- join row
      tasks: (m.tasks ?? []).map((t: any) => t.task),
    };
  }

  // ---------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------

  /**
   * Contracts are scoped to the active workspace only.
   *
   * Note there is no per-project narrowing here, unlike ProjectsService: the
   * `Contract` CASL subject is already revoked for anyone without
   * `hasFinanceAccess`, so every caller reaching this code is an org admin or
   * the finance manager, and both see the whole workspace by definition.
   */
  private async baseCurrency(workspaceId: string): Promise<string> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organization: { select: { baseCurrency: true } } },
    });
    return ws?.organization?.baseCurrency ?? 'PKR';
  }

  /**
   * The booked rate to base, same rules as payments and expenses: forced to 1
   * for the base currency, and required for any other currency, or
   * `baseTotalValue` (what dashboards report) would book USD 1,000 as PKR
   * 1,000. `undefined` keeps the stored rate (a partial update).
   */
  private bookedRate(
    currency: string,
    baseCurrency: string,
    rateInput: string | number | undefined,
    mustHaveRate: boolean,
  ) {
    if (currency === baseCurrency) return new D(1);
    if (!hasRate(rateInput)) {
      if (mustHaveRate) throw fxRateRequired(baseCurrency, currency, 'contract');
      return undefined;
    }
    return bookRate(rateInput);
  }

  private async requireContract(scope: UserScope, id: string) {
    const workspaceId = requireWorkspace(scope);
    const contract = await this.prisma.client.contract.findFirst({
      where: { id, workspaceId },
    });
    if (!contract) {
      throw new NotFoundException({
        title: 'Contract not found',
        status: 404,
        detail: 'No contract with that id in this workspace.',
        code: 'contract_not_found',
      });
    }
    return contract;
  }

  /** Confirm a project/client referenced by an input actually lives here. */
  private async assertRefs(
    workspaceId: string,
    projectId?: string | null,
    clientId?: string | null,
  ): Promise<void> {
    if (projectId) {
      const p = await this.prisma.client.project.findFirst({
        where: { id: projectId, workspaceId },
        select: { id: true },
      });
      if (!p) {
        throw new BadRequestException({
          title: 'Invalid project',
          status: 400,
          detail: 'Project not found in this workspace.',
          code: 'invalid_project',
        });
      }
    }
    if (clientId) {
      const c = await this.prisma.client.client.findFirst({
        where: { id: clientId, workspaceId },
        select: { id: true },
      });
      if (!c) {
        throw new BadRequestException({
          title: 'Invalid client',
          status: 400,
          detail: 'Client not found in this workspace.',
          code: 'invalid_client',
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  async list(scope: UserScope, q: ListContractsQuery) {
    const workspaceId = requireWorkspace(scope);
    const where: Record<string, unknown> = { workspaceId };
    if (q.status) where['status'] = q.status;
    if (q.paymentStatus) where['paymentStatus'] = q.paymentStatus;
    if (q.billingModel) where['billingModel'] = q.billingModel;
    if (q.projectId) where['projectId'] = q.projectId;
    // The client's own contracts plus client-less ones on its projects (the
    // project decides), wrapped in AND so the search OR below survives.
    if (q.clientId) where['AND'] = [clientContractWhere(q.clientId)];
    if (q.currency) where['currency'] = q.currency;
    if (q.q) {
      where['OR'] = [
        { title: { contains: q.q, mode: 'insensitive' } },
        { notes: { contains: q.q, mode: 'insensitive' } },
        { project: { name: { contains: q.q, mode: 'insensitive' } } },
        { client: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.client.contract.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: {
          project: { select: { id: true, name: true } },
          client: { select: { id: true, name: true } },
          _count: { select: { milestones: true } },
        },
      }),
      this.prisma.client.contract.count({ where }),
    ]);

    return {
      items: items.map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- include shape
        (c: any): ContractListItem => ({
          ...this.base(c),
          project: c.project ?? null,
          client: c.client ?? null,
          milestoneCount: c._count.milestones,
        }),
      ),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async get(scope: UserScope, id: string): Promise<ContractWithMilestones> {
    await this.requireContract(scope, id);
    const c = await this.prisma.client.contract.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        client: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        milestones: {
          orderBy: { position: 'asc' },
          include: MILESTONE_INCLUDE,
        },
      },
    });
    if (!c) {
      throw new NotFoundException({ title: 'Contract not found', status: 404 });
    }
    return {
      ...this.base(c),
      project: c.project ?? null,
      client: c.client ?? null,
      createdBy: c.createdBy ?? null,
      milestones: c.milestones.map((m) => this.milestone(m)),
    };
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async create(
    scope: UserScope,
    input: CreateContractInput,
  ): Promise<ContractWithMilestones> {
    const workspaceId = requireWorkspace(scope);
    await this.assertRefs(workspaceId, input.projectId, input.clientId);

    // A contract attached to a project inherits that project's client unless
    // one was named explicitly, so revenue always attributes to somebody.
    let clientId = input.clientId ?? null;
    if (!clientId && input.projectId) {
      const p = await this.prisma.client.project.findUnique({
        where: { id: input.projectId },
        select: { clientId: true },
      });
      clientId = p?.clientId ?? null;
    }

    const billingModel = input.billingModel ?? 'ONE_TIME';
    const milestones = input.milestones ?? [];
    const currency = input.currency ?? 'USD';
    const baseCurrency = await this.baseCurrency(workspaceId);
    const fxRateToBase = this.bookedRate(currency, baseCurrency, input.fxRateToBase, true) ?? new D(1);

    // For milestone contracts the stage sum is authoritative; `totalValue` on
    // the input is ignored so the two can never disagree.
    const totalValue =
      billingModel === 'ONE_TIME'
        ? toDecimal(input.totalValue, 0)
        : milestones.reduce((acc, m) => acc.plus(toDecimal(m.amount, 0)), new D(0));

    const created = await this.prisma.client.$transaction(async (tx) => {
      const contract = await tx.contract.create({
        data: {
          workspaceId,
          projectId: input.projectId ?? null,
          clientId,
          createdById: scope.userId,
          title: input.title,
          billingModel,
          status: input.status ?? 'ACTIVE',
          currency,
          totalValue: round2(totalValue),
          fxRateToBase,
          baseTotalValue: round2(totalValue.times(fxRateToBase)),
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
          notes: input.notes ?? null,
          ...(milestones.length > 0
            ? {
                milestones: {
                  create: milestones.map((m, i) => ({
                    position: i,
                    title: m.title,
                    description: m.description ?? null,
                    amount: round2(toDecimal(m.amount, 0)),
                    dueDate: m.dueDate ?? null,
                  })),
                },
              }
            : {}),
        },
        select: { id: true },
      });
      // Normalises the cached totals through the one code path that owns them,
      // rather than trusting the values computed above.
      await recalcContract(tx, contract.id);
      return contract;
    });
    await bumpFinanceSummary(this.redis, workspaceId);

    return this.get(scope, created.id);
  }

  async update(
    scope: UserScope,
    id: string,
    input: UpdateContractInput,
  ): Promise<ContractWithMilestones> {
    const existing = await this.requireContract(scope, id);
    await this.assertRefs(
      existing.workspaceId,
      input.projectId ?? undefined,
      input.clientId ?? undefined,
    );

    // Explicit field-by-field assignment rather than a spread: the input type
    // is wider than the column set (money arrives as string-or-number), and a
    // spread would be a mass-assignment hole the moment a field is added.
    const data: Record<string, unknown> = {};
    if (input.projectId !== undefined) data['projectId'] = input.projectId;
    if (input.clientId !== undefined) data['clientId'] = input.clientId;
    if (input.title !== undefined) data['title'] = input.title;
    if (input.billingModel !== undefined) data['billingModel'] = input.billingModel;
    if (input.status !== undefined) data['status'] = input.status;
    if (input.currency !== undefined) data['currency'] = input.currency;
    if (input.startDate !== undefined) data['startDate'] = input.startDate;
    if (input.endDate !== undefined) data['endDate'] = input.endDate;
    if (input.notes !== undefined) data['notes'] = input.notes;
    // Moving to another non-base currency needs that currency's rate; the
    // base currency always books at 1.
    const currency = input.currency ?? existing.currency;
    const currencyChanged = currency !== existing.currency;
    if (currencyChanged || hasRate(input.fxRateToBase)) {
      const fxRateToBase = this.bookedRate(
        currency,
        await this.baseCurrency(existing.workspaceId),
        input.fxRateToBase,
        currencyChanged,
      );
      if (fxRateToBase !== undefined) data['fxRateToBase'] = fxRateToBase;
    }
    if (input.totalValue !== undefined) {
      data['totalValue'] = round2(toDecimal(input.totalValue, 0));
    }

    // Changing the currency mid-flight would leave existing payments settling
    // in a currency the contract no longer uses, and `amountPaid` would be a
    // sum of two different units. Void the payments first.
    if (input.currency && input.currency !== existing.currency) {
      const paymentCount = await this.prisma.client.payment.count({
        where: { contractId: id, voidedAt: null },
      });
      if (paymentCount > 0) {
        throw new BadRequestException({
          title: 'Currency locked',
          status: 400,
          detail:
            'This contract already has payments recorded against it. Void them before changing its currency.',
          code: 'currency_locked',
        });
      }
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.contract.update({ where: { id }, data });
      await recalcContract(tx, id);
    });
    await bumpFinanceSummary(this.redis, existing.workspaceId);

    return this.get(scope, id);
  }

  /**
   * Soft delete - `Contract` is in SOFT_DELETE_MODELS, so `.delete()` sets
   * `deletedAt`. Payments survive with a soft-deleted parent on purpose: the
   * money did arrive, and the summary still counts it.
   */
  async remove(scope: UserScope, id: string): Promise<void> {
    const existing = await this.requireContract(scope, id);
    await this.prisma.client.contract.delete({ where: { id } });
    await bumpFinanceSummary(this.redis, existing.workspaceId);
  }
}
