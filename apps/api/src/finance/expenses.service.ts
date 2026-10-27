import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreateExpenseInput,
  ExpenseWithRefs,
  ListExpensesQuery,
  UpdateExpenseInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { isSupportRequest } from '../common/request-context';
import { generalFileVisibility } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { requireTenantRef } from '../common/tenant-scope';
import { bumpFinanceSummary } from './finance-summary-cache';
import { paymentSourceForWorkspace } from './payment-source-ref';
import {
  D,
  bookRate,
  fxRateRequired,
  hasRate,
  money,
  rate,
  requireWorkspace,
  round2,
  toDecimal,
} from './serialize';

const REFS_INCLUDE = {
  project: { select: { id: true, name: true } },
  contract: { select: { id: true, title: true } },
  paymentSource: { select: { id: true, name: true } },
  receipt: { select: { id: true, filename: true, url: true } },
  recordedBy: { select: { id: true, name: true } },
  // Present when a payroll run recorded this expense (see assertNotPayroll).
  payrollItem: { select: { id: true } },
} as const;

/** The payroll category (enum `ExpenseCategory`, upper case). */
const SALARY = 'SALARY';

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- include shape
  private serialize(e: any): ExpenseWithRefs {
    return {
      id: e.id,
      workspaceId: e.workspaceId,
      projectId: e.projectId,
      contractId: e.contractId,
      category: e.category,
      vendor: e.vendor,
      description: e.description,
      amount: money(e.amount),
      currency: e.currency,
      fxRate: rate(e.fxRate),
      baseAmount: money(e.baseAmount),
      paymentSourceId: e.paymentSourceId,
      incurredAt: e.incurredAt,
      reference: e.reference,
      receiptFileId: e.receiptFileId,
      recordedById: e.recordedById,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      deletedAt: e.deletedAt,
      project: e.project ?? null,
      contract: e.contract ?? null,
      paymentSource: e.paymentSource ?? null,
      receipt: e.receipt ?? null,
      recordedBy: e.recordedBy ?? null,
      fromPayroll: Boolean(e.payrollItem),
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
   * An expense has no "settles a contract" question, so it needs only the
   * reporting pair: amount in whatever currency it was paid, converted once.
   */
  private computeAmounts(
    input: { amount?: string | number; currency?: string; fxRate?: string | number },
    baseCurrency: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- prior row on update
    prior?: any,
  ) {
    const amount = round2(
      input.amount !== undefined ? toDecimal(input.amount, 0) : new D(prior?.amount ?? 0),
    );
    const currency = input.currency ?? prior?.currency ?? baseCurrency;
    // Same forcing rule as payments: a rate other than 1 between a currency
    // and itself is nonsense and silently corrupts the totals.
    const fxRate =
      currency === baseCurrency
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
    return { amount, currency, fxRate, baseAmount: round2(amount.times(fxRate)) };
  }

  /**
   * Every id the expense points at must be in this workspace (or, for the
   * organization-wide payment source, its organization). A receipt from
   * another org would otherwise expose that file's name and URL here.
   */
  private async assertRefs(
    workspaceId: string,
    refs: {
      projectId?: string | null;
      contractId?: string | null;
      paymentSourceId?: string | null;
      receiptFileId?: string | null;
    },
  ): Promise<void> {
    const { projectId, contractId, paymentSourceId, receiptFileId } = refs;
    if (paymentSourceId) {
      await paymentSourceForWorkspace(this.prisma, workspaceId, paymentSourceId);
    }
    if (receiptFileId) {
      requireTenantRef(
        await this.prisma.client.fileObject.findFirst({
          where: { id: receiptFileId, workspaceId, ...generalFileVisibility(true) },
          select: { id: true },
        }),
        'receipt',
        'invalid_receipt',
      );
    }
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
    if (contractId) {
      const c = await this.prisma.client.contract.findFirst({
        where: { id: contractId, workspaceId },
        select: { id: true },
      });
      if (!c) {
        throw new BadRequestException({
          title: 'Invalid contract',
          status: 400,
          detail: 'Contract not found in this workspace.',
          code: 'invalid_contract',
        });
      }
    }
  }

  async list(scope: UserScope, q: ListExpensesQuery) {
    const workspaceId = requireWorkspace(scope);
    // Read only support session: salaries are payroll data, which support
    // never sees. A salary filter matches nothing.
    const support = isSupportRequest();
    if (support && q.category === SALARY) {
      return {
        items: [],
        pagination: { page: q.page, pageSize: q.pageSize, total: 0, totalPages: 1 },
      };
    }
    const where: Record<string, unknown> = { workspaceId };
    if (q.projectId) where['projectId'] = q.projectId;
    if (q.contractId) where['contractId'] = q.contractId;
    if (q.category) where['category'] = q.category;
    else if (support) where['category'] = { not: SALARY };
    if (q.paymentSourceId) where['paymentSourceId'] = q.paymentSourceId;
    if (q.currency) where['currency'] = q.currency;
    if (q.incurredFrom || q.incurredTo) {
      where['incurredAt'] = {
        ...(q.incurredFrom ? { gte: q.incurredFrom } : {}),
        ...(q.incurredTo ? { lte: q.incurredTo } : {}),
      };
    }
    if (q.q) {
      where['OR'] = [
        { description: { contains: q.q, mode: 'insensitive' } },
        { vendor: { contains: q.q, mode: 'insensitive' } },
        { reference: { contains: q.q, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.client.expense.findMany({
        where,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: REFS_INCLUDE,
      }),
      this.prisma.client.expense.count({ where }),
    ]);

    return {
      items: items.map((e) => this.serialize(e)),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async create(scope: UserScope, input: CreateExpenseInput): Promise<ExpenseWithRefs> {
    const workspaceId = requireWorkspace(scope);
    await this.assertRefs(workspaceId, input);
    const baseCurrency = await this.baseCurrency(workspaceId);
    // Same rule as payments: a non-base amount needs its rate, or the
    // default of 1 books it as base money.
    const currency = input.currency ?? baseCurrency;
    if (currency !== baseCurrency && !hasRate(input.fxRate)) {
      throw fxRateRequired(baseCurrency, currency, 'expense');
    }
    const amounts = this.computeAmounts(input, baseCurrency);

    const created = await this.prisma.client.expense.create({
      data: {
        workspaceId,
        projectId: input.projectId ?? null,
        contractId: input.contractId ?? null,
        category: input.category ?? 'OTHER',
        vendor: input.vendor ?? null,
        description: input.description,
        paymentSourceId: input.paymentSourceId ?? null,
        incurredAt: input.incurredAt ?? new Date(),
        reference: input.reference ?? null,
        receiptFileId: input.receiptFileId ?? null,
        recordedById: scope.userId,
        ...amounts,
      },
      include: REFS_INCLUDE,
    });
    await bumpFinanceSummary(this.redis, workspaceId);
    return this.serialize(created);
  }

  async update(
    scope: UserScope,
    id: string,
    input: UpdateExpenseInput,
  ): Promise<ExpenseWithRefs> {
    const workspaceId = requireWorkspace(scope);
    const existing = await this.prisma.client.expense.findFirst({
      where: { id, workspaceId },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Expense not found', status: 404 });
    }
    await this.assertNotPayroll(id);
    await this.assertRefs(workspaceId, input);
    const baseCurrency = await this.baseCurrency(workspaceId);
    // Moving to another non-base currency needs that currency's rate;
    // otherwise the stored rate (often 1) would be reused.
    const currency = input.currency ?? existing.currency;
    if (currency !== existing.currency && currency !== baseCurrency && !hasRate(input.fxRate)) {
      throw fxRateRequired(baseCurrency, currency, 'expense');
    }
    const amounts = this.computeAmounts(input, baseCurrency, existing);

    const data: Record<string, unknown> = { ...amounts };
    if (input.projectId !== undefined) data['projectId'] = input.projectId;
    if (input.contractId !== undefined) data['contractId'] = input.contractId;
    if (input.category !== undefined) data['category'] = input.category;
    if (input.vendor !== undefined) data['vendor'] = input.vendor;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.paymentSourceId !== undefined) {
      data['paymentSourceId'] = input.paymentSourceId;
    }
    if (input.incurredAt !== undefined) data['incurredAt'] = input.incurredAt;
    if (input.reference !== undefined) data['reference'] = input.reference;
    if (input.receiptFileId !== undefined) data['receiptFileId'] = input.receiptFileId;

    const updated = await this.prisma.client.expense.update({
      where: { id },
      data,
      include: REFS_INCLUDE,
    });
    await bumpFinanceSummary(this.redis, workspaceId);
    return this.serialize(updated);
  }

  /** Soft delete - `Expense` is in SOFT_DELETE_MODELS. */
  async remove(scope: UserScope, id: string): Promise<void> {
    const workspaceId = requireWorkspace(scope);
    const existing = await this.prisma.client.expense.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Expense not found', status: 404 });
    }
    await this.assertNotPayroll(id);
    await this.prisma.client.expense.delete({ where: { id } });
    await bumpFinanceSummary(this.redis, workspaceId);
  }

  /**
   * A salary expense recorded by a payroll run belongs to that run: editing
   * or deleting it here would leave the run and its payslips disagreeing with
   * the books. It changes through the run (undo paid) instead.
   */
  private async assertNotPayroll(expenseId: string): Promise<void> {
    const item = await this.prisma.client.payrollItem.findUnique({
      where: { expenseId },
      select: { id: true },
    });
    if (item) {
      throw new ConflictException({
        title: 'Recorded by payroll',
        status: 409,
        detail: 'This salary was recorded by a payroll run. Undo the payroll payment to change it.',
        code: 'payroll_expense',
      });
    }
  }
}
