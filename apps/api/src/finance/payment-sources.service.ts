import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  CreatePaymentSourceInput,
  ListPaymentSourcesQuery,
  PaymentSourceWithUsage,
  ReorderPaymentSourcesInput,
  UpdatePaymentSourceInput,
} from '@botss/shared-types';

import { isSupportRequest } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { bumpFinanceSummary } from './finance-summary-cache';
import { money, toDecimal } from './serialize';

/**
 * The rails The Botss actually gets paid through. Mirrors the SQL seed in
 * `20260828122000_seed_payment_sources` so an org created AFTER that migration
 * still starts with a usable list instead of an empty picker.
 */
const DEFAULT_SOURCES: ReadonlyArray<{
  name: string;
  kind: 'FREELANCE_PLATFORM' | 'BANK' | 'REMITTANCE' | 'WALLET' | 'GATEWAY' | 'CASH' | 'OTHER';
  defaultRegion: 'LOCAL' | 'INTERNATIONAL' | null;
  defaultFeePercent: number | null;
}> = [
  { name: 'Upwork', kind: 'FREELANCE_PLATFORM', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 10 },
  { name: 'Fiverr', kind: 'FREELANCE_PLATFORM', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 20 },
  { name: 'Payoneer', kind: 'WALLET', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 2 },
  { name: 'Wise', kind: 'REMITTANCE', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 1 },
  { name: 'Remitly', kind: 'REMITTANCE', defaultRegion: 'INTERNATIONAL', defaultFeePercent: null },
  { name: 'PayPal', kind: 'GATEWAY', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 4.4 },
  { name: 'Stripe', kind: 'GATEWAY', defaultRegion: 'INTERNATIONAL', defaultFeePercent: 2.9 },
  { name: 'IBFT / Local Bank Transfer', kind: 'BANK', defaultRegion: 'LOCAL', defaultFeePercent: null },
  { name: 'Cash', kind: 'CASH', defaultRegion: 'LOCAL', defaultFeePercent: null },
  { name: 'Other', kind: 'OTHER', defaultRegion: null, defaultFeePercent: null },
];

@Injectable()
export class PaymentSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- include shape varies
  private serialize(s: any): PaymentSourceWithUsage {
    return {
      id: s.id,
      organizationId: s.organizationId,
      name: s.name,
      kind: s.kind,
      defaultRegion: s.defaultRegion,
      defaultFeePercent: s.defaultFeePercent == null ? null : money(s.defaultFeePercent),
      isActive: s.isActive,
      position: s.position,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      usageCount: (s._count?.payments ?? 0) + (s._count?.expenses ?? 0),
    };
  }

  /**
   * Seed the default rails the first time an org reads the list. Idempotent
   * via `skipDuplicates` on the (organizationId, name) unique index, so an org
   * that deleted "Fiverr" does not get it back on the next read - only a
   * genuinely empty list is populated.
   */
  private async ensureDefaults(organizationId: string): Promise<void> {
    const existing = await this.prisma.client.paymentSource.count({
      where: { organizationId },
    });
    if (existing > 0) return;
    await this.prisma.client.paymentSource.createMany({
      data: DEFAULT_SOURCES.map((s, i) => ({
        organizationId,
        name: s.name,
        kind: s.kind,
        defaultRegion: s.defaultRegion,
        defaultFeePercent: s.defaultFeePercent,
        position: i,
      })),
      skipDuplicates: true,
    });
  }

  async list(organizationId: string, q: ListPaymentSourcesQuery) {
    // A read only support session never seeds anything (a GET with a write).
    if (!isSupportRequest()) await this.ensureDefaults(organizationId);
    const rows = await this.prisma.client.paymentSource.findMany({
      where: {
        organizationId,
        ...(q.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { payments: true, expenses: true } } },
    });
    return { items: rows.map((r) => this.serialize(r)) };
  }

  async create(organizationId: string, input: CreatePaymentSourceInput) {
    const clash = await this.prisma.client.paymentSource.findFirst({
      where: { organizationId, name: input.name },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException({
        title: 'Duplicate payment source',
        status: 400,
        detail: `A payment source named "${input.name}" already exists.`,
        code: 'duplicate_payment_source',
      });
    }
    // Append to the end unless a position was given, so a new rail does not
    // silently displace the one the finance manager uses most.
    const last = await this.prisma.client.paymentSource.aggregate({
      where: { organizationId },
      _max: { position: true },
    });
    const created = await this.prisma.client.paymentSource.create({
      data: {
        organizationId,
        name: input.name,
        kind: input.kind ?? 'OTHER',
        defaultRegion: input.defaultRegion ?? null,
        defaultFeePercent:
          input.defaultFeePercent == null
            ? null
            : toDecimal(input.defaultFeePercent, 0),
        position: input.position ?? (last._max.position ?? -1) + 1,
      },
      include: { _count: { select: { payments: true, expenses: true } } },
    });
    return this.serialize(created);
  }

  async update(
    organizationId: string,
    id: string,
    input: UpdatePaymentSourceInput,
  ) {
    await this.require(organizationId, id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.kind !== undefined) data['kind'] = input.kind;
    if (input.defaultRegion !== undefined) data['defaultRegion'] = input.defaultRegion;
    if (input.position !== undefined) data['position'] = input.position;
    if (input.isActive !== undefined) data['isActive'] = input.isActive;
    if (input.defaultFeePercent !== undefined) {
      data['defaultFeePercent'] =
        input.defaultFeePercent == null
          ? null
          : toDecimal(input.defaultFeePercent, 0);
    }
    const updated = await this.prisma.client.paymentSource.update({
      where: { id },
      data,
      include: { _count: { select: { payments: true, expenses: true } } },
    });
    // The finance summary prints source names and kinds (`bySource`), and a
    // source is org-wide, so every workspace's cached summary goes stale.
    if (input.name !== undefined || input.kind !== undefined) {
      const workspaces = await this.prisma.client.workspace.findMany({
        where: { organizationId },
        select: { id: true },
      });
      await bumpFinanceSummary(this.redis, ...workspaces.map((w) => w.id));
    }
    return this.serialize(updated);
  }

  async reorder(organizationId: string, input: ReorderPaymentSourcesInput) {
    const owned = await this.prisma.client.paymentSource.findMany({
      where: { organizationId, id: { in: input.ids } },
      select: { id: true },
    });
    if (owned.length !== input.ids.length) {
      throw new BadRequestException({
        title: 'Invalid reorder',
        status: 400,
        detail: 'One or more payment sources do not belong to this organization.',
        code: 'invalid_reorder',
      });
    }
    await this.prisma.client.$transaction(
      input.ids.map((id, position) =>
        this.prisma.client.paymentSource.update({ where: { id }, data: { position } }),
      ),
    );
    return { ok: true };
  }

  /**
   * Deactivate, or hard-delete when nothing references it.
   *
   * A rail with payments against it can never be removed - the FK is
   * `onDelete: Restrict` precisely so historical money keeps its provenance.
   * Deactivating hides it from the picker while leaving old rows readable.
   */
  async remove(organizationId: string, id: string) {
    await this.require(organizationId, id);
    // The bare client for expenses and payroll runs: a soft-deleted row (an
    // undone payroll payment, a removed expense) still holds the FK, and
    // missing it here turned "deactivate" into a failed hard delete.
    const [payments, expenses, payrollRuns] = await Promise.all([
      this.prisma.client.payment.count({ where: { paymentSourceId: id } }),
      this.prisma.raw.expense.count({ where: { paymentSourceId: id } }),
      this.prisma.raw.payrollRun.count({ where: { paymentSourceId: id } }),
    ]);
    if (payments + expenses + payrollRuns > 0) {
      await this.prisma.client.paymentSource.update({
        where: { id },
        data: { isActive: false },
      });
      return { ok: true, deactivated: true };
    }
    await this.prisma.client.paymentSource.delete({ where: { id } });
    return { ok: true, deactivated: false };
  }

  private async require(organizationId: string, id: string) {
    const row = await this.prisma.client.paymentSource.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException({
        title: 'Payment source not found',
        status: 404,
        code: 'payment_source_not_found',
      });
    }
    return row;
  }
}
