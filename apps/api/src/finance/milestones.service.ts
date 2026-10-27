import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AwaitingPaymentItem,
  CreateMilestoneInput,
  LinkMilestoneWorkInput,
  ReorderMilestonesInput,
  UpdateMilestoneInput,
} from '@botss/shared-types';

import type { UserScope } from '../common/decorators/user-scope.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { bumpFinanceSummary } from './finance-summary-cache';
import { recalcContract } from './contract-totals';
import { money, requireWorkspace, round2, toDecimal } from './serialize';

@Injectable()
export class MilestonesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private async requireContract(scope: UserScope, contractId: string) {
    const workspaceId = requireWorkspace(scope);
    const contract = await this.prisma.client.contract.findFirst({
      where: { id: contractId, workspaceId },
      select: { id: true, workspaceId: true, projectId: true },
    });
    if (!contract) {
      throw new NotFoundException({
        title: 'Contract not found',
        status: 404,
        code: 'contract_not_found',
      });
    }
    return contract;
  }

  private async requireMilestone(scope: UserScope, id: string) {
    const workspaceId = requireWorkspace(scope);
    const milestone = await this.prisma.client.contractMilestone.findFirst({
      where: { id, contract: { workspaceId } },
      include: { contract: { select: { id: true, workspaceId: true, projectId: true } } },
    });
    if (!milestone) {
      throw new NotFoundException({
        title: 'Milestone not found',
        status: 404,
        code: 'milestone_not_found',
      });
    }
    return milestone;
  }

  async create(scope: UserScope, contractId: string, input: CreateMilestoneInput) {
    const contract = await this.requireContract(scope, contractId);
    if (input.sprintId) await this.assertSprint(contract, input.sprintId);

    const last = await this.prisma.client.contractMilestone.aggregate({
      where: { contractId },
      _max: { position: true },
    });

    const created = await this.prisma.client.$transaction(async (tx) => {
      const m = await tx.contractMilestone.create({
        data: {
          contractId,
          position: (last._max.position ?? -1) + 1,
          title: input.title,
          description: input.description ?? null,
          amount: round2(toDecimal(input.amount, 0)),
          dueDate: input.dueDate ?? null,
          sprintId: input.sprintId ?? null,
          autoDeliver: input.autoDeliver ?? true,
        },
        select: { id: true },
      });
      // Adding a stage moves the contract total for milestone-billed work.
      await recalcContract(tx, contractId);
      return m;
    });
    await bumpFinanceSummary(this.redis, contract.workspaceId);

    return this.getOne(created.id);
  }

  async update(scope: UserScope, id: string, input: UpdateMilestoneInput) {
    const existing = await this.requireMilestone(scope, id);
    if (input.sprintId) {
      await this.assertSprint(existing.contract, input.sprintId);
    }

    const data: Record<string, unknown> = {};
    if (input.title !== undefined) data['title'] = input.title;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.dueDate !== undefined) data['dueDate'] = input.dueDate;
    if (input.sprintId !== undefined) data['sprintId'] = input.sprintId;
    if (input.autoDeliver !== undefined) data['autoDeliver'] = input.autoDeliver;
    if (input.amount !== undefined) data['amount'] = round2(toDecimal(input.amount, 0));
    if (input.status !== undefined) {
      // Delivery only. `paymentStatus` is derived and has no setter.
      data['status'] = input.status;
      data['deliveredAt'] =
        input.status === 'DELIVERED' ? (existing.deliveredAt ?? new Date()) : null;
    }

    await this.prisma.client.$transaction(async (tx) => {
      await tx.contractMilestone.update({ where: { id }, data });
      await recalcContract(tx, existing.contractId);
    });
    await bumpFinanceSummary(this.redis, requireWorkspace(scope));

    return this.getOne(id);
  }

  /**
   * Replace the project work a milestone bills.
   *
   * Replaces rather than merges: the picker sends the full intended set, and a
   * merge would make removing a task impossible.
   */
  async linkWork(scope: UserScope, id: string, input: LinkMilestoneWorkInput) {
    const existing = await this.requireMilestone(scope, id);
    if (input.sprintId) {
      await this.assertSprint(existing.contract, input.sprintId);
    }
    if (input.taskIds && input.taskIds.length > 0) {
      const count = await this.prisma.client.task.count({
        where: {
          id: { in: input.taskIds },
          project: { workspaceId: existing.contract.workspaceId },
          ...(existing.contract.projectId
            ? { projectId: existing.contract.projectId }
            : {}),
        },
      });
      if (count !== input.taskIds.length) {
        throw new BadRequestException({
          title: 'Invalid tasks',
          status: 400,
          detail: 'One or more tasks do not belong to this contract’s project.',
          code: 'invalid_tasks',
        });
      }
    }

    await this.prisma.client.$transaction(async (tx) => {
      const data: Record<string, unknown> = {};
      if (input.sprintId !== undefined) data['sprintId'] = input.sprintId;
      if (input.autoDeliver !== undefined) data['autoDeliver'] = input.autoDeliver;
      if (Object.keys(data).length > 0) {
        await tx.contractMilestone.update({ where: { id }, data });
      }
      if (input.taskIds !== undefined) {
        await tx.milestoneTask.deleteMany({ where: { milestoneId: id } });
        if (input.taskIds.length > 0) {
          await tx.milestoneTask.createMany({
            data: input.taskIds.map((taskId) => ({ milestoneId: id, taskId })),
            skipDuplicates: true,
          });
        }
      }
    });

    return this.getOne(id);
  }

  /** Manual delivery, for milestones with no linked sprint or tasks. */
  async deliver(scope: UserScope, id: string) {
    const existing = await this.requireMilestone(scope, id);
    if (existing.status === 'CANCELLED') {
      throw new BadRequestException({
        title: 'Milestone cancelled',
        status: 400,
        detail: 'A cancelled milestone cannot be marked delivered.',
        code: 'milestone_cancelled',
      });
    }
    await this.prisma.client.contractMilestone.update({
      where: { id },
      data: { status: 'DELIVERED', deliveredAt: existing.deliveredAt ?? new Date() },
    });
    await bumpFinanceSummary(this.redis, requireWorkspace(scope));
    return this.getOne(id);
  }

  /**
   * Reorder in two passes inside one transaction.
   *
   * `@@unique([contractId, position])` means a naive single pass collides the
   * moment two rows briefly share a position. Negating first moves every row
   * out of the positive range, so the second pass can land anywhere.
   */
  async reorder(scope: UserScope, contractId: string, input: ReorderMilestonesInput) {
    await this.requireContract(scope, contractId);
    const all = await this.prisma.client.contractMilestone.findMany({
      where: { contractId },
      select: { id: true },
    });
    // The ids must be exactly the contract's full milestone set: a subset
    // would land on positions 0..n-1 that rows left out still hold and
    // collide with @@unique([contractId, position]).
    if (!isSameIdSet(all.map((m) => m.id), input.ids)) {
      throw new BadRequestException({
        title: 'Invalid reorder',
        status: 400,
        detail: 'Send every milestone of this contract exactly once, in the new order.',
        code: 'invalid_reorder',
      });
    }

    await this.prisma.client.$transaction(async (tx) => {
      for (let i = 0; i < input.ids.length; i += 1) {
        await tx.contractMilestone.update({
          where: { id: input.ids[i] as string },
          data: { position: -(i + 1) },
        });
      }
      for (let i = 0; i < input.ids.length; i += 1) {
        await tx.contractMilestone.update({
          where: { id: input.ids[i] as string },
          data: { position: i },
        });
      }
    });

    return { ok: true };
  }

  /**
   * Hard delete - milestones are not soft-deleted, they cascade from their
   * contract. Payments against the milestone survive via `onDelete: SetNull`
   * and are reattributed to the contract tier by the recalc.
   */
  async remove(scope: UserScope, id: string) {
    const existing = await this.requireMilestone(scope, id);
    await this.prisma.client.$transaction(async (tx) => {
      await tx.contractMilestone.delete({ where: { id } });
      await recalcContract(tx, existing.contractId);
    });
    await bumpFinanceSummary(this.redis, requireWorkspace(scope));
  }

  /**
   * Delivered work that has not been fully paid for. This is the payoff of
   * linking milestones to sprints: it is the list the finance manager chases.
   */
  async awaitingPayment(scope: UserScope): Promise<{ items: AwaitingPaymentItem[] }> {
    const workspaceId = requireWorkspace(scope);
    const rows = await this.prisma.client.contractMilestone.findMany({
      where: {
        status: 'DELIVERED',
        paymentStatus: { in: ['NOT_PAID', 'PARTIAL'] },
        contract: { workspaceId, deletedAt: null, status: { not: 'CANCELLED' } },
      },
      orderBy: [{ dueDate: 'asc' }, { deliveredAt: 'asc' }],
      take: 200,
      include: {
        contract: {
          select: {
            id: true,
            title: true,
            currency: true,
            project: { select: { id: true, name: true } },
            client: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      items: rows.map((m) => ({
        milestoneId: m.id,
        contractId: m.contract.id,
        contractTitle: m.contract.title,
        milestoneTitle: m.title,
        currency: m.contract.currency,
        amount: money(m.amount),
        amountPaid: money(m.amountPaid),
        paymentStatus: m.paymentStatus,
        deliveredAt: m.deliveredAt,
        dueDate: m.dueDate,
        project: m.contract.project ?? null,
        client: m.contract.client ?? null,
      })),
    };
  }

  /**
   * The sprint must be in the contract's workspace, and in its project when
   * the contract has one. Without the workspace filter a contract with no
   * project could bill another org's sprint.
   */
  private async assertSprint(
    contract: { workspaceId: string; projectId: string | null },
    sprintId: string,
  ) {
    const sprint = await this.prisma.client.sprint.findFirst({
      where: {
        id: sprintId,
        project: { workspaceId: contract.workspaceId },
        ...(contract.projectId ? { projectId: contract.projectId } : {}),
      },
      select: { id: true },
    });
    if (!sprint) {
      throw new BadRequestException({
        title: 'Invalid sprint',
        status: 400,
        detail: 'That sprint does not belong to this contract’s project.',
        code: 'invalid_sprint',
      });
    }
  }

  private async getOne(id: string) {
    const m = await this.prisma.client.contractMilestone.findUnique({
      where: { id },
      include: {
        sprint: { select: { id: true, name: true, status: true } },
        tasks: { select: { task: { select: { id: true, title: true, status: true } } } },
      },
    });
    if (!m) throw new NotFoundException({ title: 'Milestone not found', status: 404 });
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
      tasks: m.tasks.map((t) => t.task),
    };
  }
}

/** True when `ids` holds exactly the members of `owned`, each once. */
function isSameIdSet(owned: readonly string[], ids: readonly string[]): boolean {
  if (owned.length !== ids.length) return false;
  const unique = new Set(ids);
  if (unique.size !== ids.length) return false;
  return owned.every((id) => unique.has(id));
}
