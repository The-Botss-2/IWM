import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type {
  CreateClientInput,
  ListClientsQuery,
  UpdateClientInput,
} from '@botss/shared-types';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { bumpFinanceSummary } from '../finance/finance-summary-cache';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { clientNotFound, clientVisibleWhere, clientWritableWhere } from './client-visibility';

/** The two people attached to every client: `owner` is the creator (read-only
    in the UI), `assignee` is who works it and who may see it. */
const PEOPLE_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true, image: true } },
  assignee: { select: { id: true, name: true, email: true, image: true } },
} as const;

/** Reshape the Prisma row so the wire format calls the creator `owner`. */
function withPeople<T extends { createdBy: unknown }>(row: T) {
  const { createdBy, ...rest } = row;
  return { ...rest, owner: createdBy };
}

@Injectable()
export class ClientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  /** Guard the actions that stay reserved for full sales access. */
  private assertFullAccess(actor: SalesActor, action: string): void {
    if (actor.fullClients) return;
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: `Only workspace admins and the sales team can ${action} clients.`,
      code: 'insufficient_permissions',
    });
  }

  /** Reject an assignee that isn't in the same org as the client's workspace. */
  private async assertAssigneeInOrg(
    workspaceId: string,
    assigneeId: string,
  ): Promise<void> {
    const [ws, assignee] = await Promise.all([
      this.prisma.client.workspace.findUnique({
        where: { id: workspaceId },
        select: { organizationId: true },
      }),
      this.prisma.client.user.findUnique({
        where: { id: assigneeId },
        select: { organizationId: true },
      }),
    ]);
    if (!assignee || (ws?.organizationId && assignee.organizationId !== ws.organizationId)) {
      throw new BadRequestException({
        title: 'Invalid assignee',
        status: 400,
        detail: 'The assignee must belong to the same organization.',
      });
    }
  }

  async list(actor: SalesActor, q: ListClientsQuery) {
    const where: Record<string, unknown> = { workspaceId: actor.workspaceId };
    if (q.search) {
      where['OR'] = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
        { legalName: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.status) where['status'] = q.status;
    if (q.assigneeId) where['assigneeId'] = q.assigneeId;
    // Applied last so it overwrites any `assigneeId` the caller asked to filter
    // by - the query string is a convenience filter, never a way to widen scope.
    Object.assign(where, clientVisibleWhere(actor));

    const skip = (q.page - 1) * q.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.client.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: PEOPLE_INCLUDE,
      }),
      this.prisma.client.client.count({ where }),
    ]);
    return {
      items: items.map(withPeople),
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  /** Read access: see `clientVisibleWhere` (finance roles read every client). */
  async get(actor: SalesActor, id: string) {
    return this.load(actor, id, 'read');
  }

  private async load(actor: SalesActor, id: string, mode: 'read' | 'write') {
    const visible = mode === 'read' ? clientVisibleWhere(actor) : clientWritableWhere(actor);
    const client = await this.prisma.client.client.findFirst({
      where: { AND: [{ id }, visible] },
      include: {
        ...PEOPLE_INCLUDE,
        // The reverse side of `Lead.convertedToClientId`. Returning a minimal
        // summary keeps the detail response useful without dragging the full
        // lead row across the wire.
        convertedFrom: { select: { id: true, name: true, convertedAt: true } },
      },
    });
    // A client that exists but isn't assigned to this user 404s rather than
    // 403s, so the response never confirms that a record they can't see exists.
    if (!client) throw clientNotFound();
    const { convertedFrom, ...rest } = withPeople(client);
    return { ...rest, convertedFromLead: convertedFrom ?? null };
  }

  async create(actor: SalesActor, input: CreateClientInput) {
    this.assertFullAccess(actor, 'create');
    if (input.assigneeId) {
      await this.assertAssigneeInOrg(actor.workspaceId, input.assigneeId);
    }
    const created = await this.prisma.client.client.create({
      data: {
        workspaceId: actor.workspaceId,
        createdById: actor.userId,
        name: input.name,
        legalName: input.legalName,
        email: input.email,
        phone: input.phone,
        website: input.website,
        industry: input.industry,
        status: input.status ?? 'PROSPECT',
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        state: input.state,
        postalCode: input.postalCode,
        country: input.country,
        taxId: input.taxId,
        notes: input.notes,
        tags: input.tags ?? [],
        assigneeId: input.assigneeId,
      },
    });
    if (input.assigneeId && input.assigneeId !== actor.userId) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: actor.userId,
          type: 'CLIENT_ASSIGNED',
          title: 'A client was assigned to you',
          body: created.name,
          entityType: 'client',
          entityId: created.id,
          url: '/clients',
        })
        .catch(() => {});
    }
    return created;
  }

  async update(actor: SalesActor, id: string, input: UpdateClientInput) {
    // Write access, not read: finance visibility is read-only.
    const existing = await this.load(actor, id, 'write');
    // Reassignment is an admin decision, not the assignee's. Letting an
    // assignee hand the client on would also silently revoke their own access
    // to it mid-edit, so it's rejected outright rather than half-applied.
    if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
      this.assertFullAccess(actor, 'reassign');
    }
    if (input.assigneeId) {
      await this.assertAssigneeInOrg(actor.workspaceId, input.assigneeId);
    }
    // Whitelist explicitly to defuse future schema-drift mass-assignment.
    const updated = await this.prisma.client.client.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.legalName !== undefined ? { legalName: input.legalName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.website !== undefined ? { website: input.website } : {}),
        ...(input.industry !== undefined ? { industry: input.industry } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
        ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
        ...(input.city !== undefined ? { city: input.city } : {}),
        ...(input.state !== undefined ? { state: input.state } : {}),
        ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
        ...(input.country !== undefined ? { country: input.country } : {}),
        ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      },
    });
    // The finance summary's top-clients list prints the client name.
    if (input.name !== undefined && input.name !== existing.name) {
      await bumpFinanceSummary(this.redis, updated.workspaceId);
    }
    if (
      input.assigneeId &&
      input.assigneeId !== existing.assigneeId &&
      input.assigneeId !== actor.userId
    ) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: actor.userId,
          type: 'CLIENT_ASSIGNED',
          title: 'A client was assigned to you',
          body: updated.name,
          entityType: 'client',
          entityId: updated.id,
          url: '/clients',
        })
        .catch(() => {});
    }
    return updated;
  }

  async remove(actor: SalesActor, id: string) {
    this.assertFullAccess(actor, 'delete');
    await this.load(actor, id, 'write');
    await this.prisma.client.client.delete({ where: { id } });
  }
}
