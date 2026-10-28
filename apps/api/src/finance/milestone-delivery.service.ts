import { Injectable, Logger } from '@nestjs/common';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { bumpFinanceSummary } from './finance-summary-cache';

/**
 * Keeps milestone DELIVERY in step with the project work that earns it.
 *
 * Called fire-and-forget from the sprint-complete and task-status paths, so a
 * failure here can never roll back the project-side write that triggered it.
 *
 * Delivery never moves money. `DELIVERED` means the work shipped and the
 * milestone has become billable - it is the signal to raise an invoice, and it
 * is what puts the row into the "Awaiting payment" panel.
 */
@Injectable()
export class MilestoneDeliveryService {
  private readonly log = new Logger(MilestoneDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * A sprint reached COMPLETED.
   *
   * No task check is needed: `SprintsService.complete()` bounces every
   * not-DONE / not-CANCELLED task out of the sprint before it commits, so by
   * the time we get here everything still in the sprint is finished.
   */
  async syncDeliveryForSprint(sprintId: string): Promise<void> {
    try {
      const sprint = await this.prisma.client.sprint.findUnique({
        where: { id: sprintId },
        select: { id: true, status: true },
      });
      if (!sprint || sprint.status !== 'COMPLETED') return;

      const milestones = await this.prisma.client.contractMilestone.findMany({
        where: {
          sprintId,
          autoDeliver: true,
          status: { notIn: ['DELIVERED', 'CANCELLED'] },
        },
        select: { id: true },
      });
      const recipientCache: RecipientCache = new Map();
      for (const m of milestones) await this.markDelivered(m.id, recipientCache);
    } catch (err) {
      this.log.warn(
        `Milestone delivery sync failed for sprint ${sprintId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * A task changed status. Only milestones that bill an explicit task set are
   * considered - a sprint-linked milestone waits for the sprint itself, so
   * finishing one task early does not prematurely bill the client.
   */
  async syncDeliveryForTask(taskId: string): Promise<void> {
    try {
      const links = await this.prisma.client.milestoneTask.findMany({
        where: { taskId },
        select: { milestoneId: true },
      });
      if (links.length === 0) return;

      // One read for every linked milestone instead of one per link.
      const rows = await this.prisma.client.contractMilestone.findMany({
        where: { id: { in: links.map((l) => l.milestoneId) } },
        select: { id: true, status: true, autoDeliver: true, sprintId: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const recipientCache: RecipientCache = new Map();

      for (const link of links) {
        const milestone = byId.get(link.milestoneId);
        if (!milestone || !milestone.autoDeliver) continue;
        if (milestone.status === 'DELIVERED' || milestone.status === 'CANCELLED') continue;
        // Sprint linkage wins: the sprint is the delivery boundary.
        if (milestone.sprintId) continue;

        // There is no existing "all tasks done" helper in the repo (sprint
        // progress is computed client-side), so count it here: one total and
        // one remaining, rather than loading every row.
        const [total, remaining] = await Promise.all([
          this.prisma.client.milestoneTask.count({
            where: { milestoneId: milestone.id },
          }),
          this.prisma.client.milestoneTask.count({
            where: {
              milestoneId: milestone.id,
              task: { status: { notIn: ['DONE', 'CANCELLED'] } },
            },
          }),
        ]);
        if (total === 0 || remaining > 0) continue;

        await this.markDelivered(milestone.id, recipientCache);
      }
    } catch (err) {
      this.log.warn(`Milestone delivery sync failed for task ${taskId}: ${(err as Error).message}`);
    }
  }

  private async markDelivered(milestoneId: string, recipientCache: RecipientCache): Promise<void> {
    const updated = await this.prisma.client.contractMilestone.update({
      where: { id: milestoneId },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
      include: {
        contract: {
          select: { id: true, title: true, workspaceId: true, currency: true },
        },
      },
    });
    await bumpFinanceSummary(this.redis, updated.contract.workspaceId);

    const recipients = await this.financeRecipients(updated.contract.workspaceId, recipientCache);
    if (!recipients) return;

    await this.notifications.emitMany(recipients, {
      type: 'MILESTONE_DELIVERED',
      title: 'Milestone delivered',
      body: `${updated.title} - ${updated.contract.title} is ready to invoice`,
      entityType: 'contract',
      entityId: updated.contract.id,
      url: `/financials/${updated.contract.id}?tab=milestones`,
    });
  }

  /**
   * Finance recipients for a workspace's organization, or null when the
   * workspace is gone. Memoised per sync run so delivering several milestones
   * in one sprint/task pass does not repeat the same two lookups.
   */
  private async financeRecipients(
    workspaceId: string,
    cache: RecipientCache,
  ): Promise<string[] | null> {
    const hit = cache.get(workspaceId);
    if (hit !== undefined) return hit;

    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    if (!ws) {
      cache.set(workspaceId, null);
      return null;
    }

    // Tell the people who chase the money, not the people who did the work.
    const recipients = await this.prisma.client.user.findMany({
      where: {
        organizationId: ws.organizationId,
        systemRole: { in: ['ADMIN', 'SUPER_ADMIN', 'FINANCE'] },
      },
      select: { id: true },
    });
    const ids = recipients.map((r) => r.id);
    cache.set(workspaceId, ids);
    return ids;
  }
}

/** workspaceId -> finance recipient ids (null = workspace not found). */
type RecipientCache = Map<string, string[] | null>;
