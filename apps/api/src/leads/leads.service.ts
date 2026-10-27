import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  ConvertLeadInput,
  CreateLeadInput,
  ListLeadsQuery,
  UpdateLeadInput,
} from '@botss/shared-types';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

/** Strict allow-list for the public website/chatbot lead intake. Anything not
    listed here (workspaceId, assigneeId, source, stage, …) can NEVER be set
    from the request — those are fixed server-side. */
const externalLeadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(160).optional(),
  intent: z.string().trim().max(2000).optional(),
  page: z.string().max(300).optional(),
  ts: z.number().int(),
});
const INTAKE_REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** Max leads one follow-up sweep pass stamps + notifies. */
const SWEEP_BATCH_SIZE = 500;

/** The two people attached to every lead: `owner` is the creator (read-only in
    the UI), `assignee` is who works it and who may see it. */
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
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Rows this actor is allowed to touch. Full sales access sees the whole
   * workspace; everyone else is pinned to leads assigned to them, which is
   * what makes assignment the access grant.
   */
  private visibilityFilter(actor: SalesActor): Record<string, unknown> {
    return actor.fullLeads
      ? { workspaceId: actor.workspaceId }
      : { workspaceId: actor.workspaceId, assigneeId: actor.userId };
  }

  /** Guard the actions that stay reserved for full sales access. */
  private assertFullAccess(actor: SalesActor, action: string): void {
    if (actor.fullLeads) return;
    throw new ForbiddenException({
      title: 'Forbidden',
      status: 403,
      detail: `Only workspace admins and the sales team can ${action} leads.`,
      code: 'insufficient_permissions',
    });
  }

  /** Reject an assignee that isn't in the same org as the lead's workspace. */
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

  async list(actor: SalesActor, q: ListLeadsQuery) {
    const where: Record<string, unknown> = { workspaceId: actor.workspaceId };
    if (q.search) {
      where['OR'] = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
        { company: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    if (q.stage) where['stage'] = q.stage;
    if (q.source) where['source'] = q.source;
    if (q.assigneeId) where['assigneeId'] = q.assigneeId;
    // Applied last so it overwrites any `assigneeId` the caller asked to filter
    // by - the query string is a convenience filter, never a way to widen scope.
    if (!actor.fullLeads) where['assigneeId'] = actor.userId;

    const skip = (q.page - 1) * q.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.lead.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        include: PEOPLE_INCLUDE,
      }),
      this.prisma.client.lead.count({ where }),
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

  async get(actor: SalesActor, id: string) {
    const lead = await this.prisma.client.lead.findFirst({
      where: { id, ...this.visibilityFilter(actor) },
      include: PEOPLE_INCLUDE,
    });
    // A lead that exists but isn't assigned to this user 404s rather than
    // 403s, so the response never confirms that a record they can't see exists.
    if (!lead) throw new NotFoundException({ title: 'Lead not found', status: 404 });
    return withPeople(lead);
  }

  async create(actor: SalesActor, input: CreateLeadInput) {
    this.assertFullAccess(actor, 'create');
    if (input.assigneeId) {
      await this.assertAssigneeInOrg(actor.workspaceId, input.assigneeId);
    }
    const created = await this.prisma.client.lead.create({
      data: {
        workspaceId: actor.workspaceId,
        createdById: actor.userId,
        name: input.name,
        email: input.email,
        phone: input.phone,
        company: input.company,
        jobTitle: input.jobTitle,
        source: input.source ?? 'OTHER',
        stage: input.stage ?? 'NEW',
        estimatedValue: input.estimatedValue,
        currency: input.currency ?? 'USD',
        notes: input.notes,
        tags: input.tags ?? [],
        assigneeId: input.assigneeId,
        followupAt: input.followupAt ?? null,
      },
    });
    if (input.assigneeId && input.assigneeId !== actor.userId) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: actor.userId,
          type: 'LEAD_ASSIGNED',
          title: 'A lead was assigned to you',
          body: created.name,
          entityType: 'lead',
          entityId: created.id,
          url: '/leads',
        })
        .catch(() => {});
    }
    return created;
  }

  /**
   * Public website / chatbot lead intake. Authenticated by an HMAC signature
   * over the raw request body using CHATBOT_INTAKE_SECRET — NOT a user session.
   * Tenancy (workspace) and ownership (creator) are fixed server-side from env,
   * so even a leaked secret can only create WEBSITE/NEW leads in the configured
   * workspace — it can never target another workspace or impersonate a user.
   *
   * Leads land unassigned, so only users with full sales access see them until
   * someone assigns them out.
   */
  async createFromExternalIntake(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<{ id: string }> {
    const secret = process.env.CHATBOT_INTAKE_SECRET?.trim();
    const workspaceId = process.env.CHATBOT_INTAKE_WORKSPACE_ID?.trim();
    const createdById = process.env.CHATBOT_INTAKE_USER_ID?.trim();
    if (!secret || !workspaceId || !createdById) {
      throw new ServiceUnavailableException({
        title: 'Lead intake is not configured',
        status: 503,
      });
    }
    if (!rawBody || !signature) {
      throw new UnauthorizedException({ title: 'Missing signature', status: 401 });
    }

    // Constant-time HMAC check over the exact bytes the caller signed.
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const given = Buffer.from(signature, 'hex');
    const want = Buffer.from(expected, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new UnauthorizedException({ title: 'Invalid signature', status: 401 });
    }

    let data: z.infer<typeof externalLeadSchema>;
    try {
      data = externalLeadSchema.parse(JSON.parse(rawBody.toString('utf8')));
    } catch {
      throw new BadRequestException({ title: 'Invalid lead payload', status: 400 });
    }

    // Anti-replay: reject stale or future-dated requests...
    if (Math.abs(Date.now() - data.ts) > INTAKE_REPLAY_WINDOW_MS) {
      throw new UnauthorizedException({ title: 'Stale request', status: 401 });
    }
    // ...and any exact request seen before inside the window. The timestamp
    // check alone let a captured request be replayed for five minutes,
    // minting a duplicate lead each time. The signature identifies the exact
    // signed body; SET NX claims it once. The key lives for the whole span a
    // timestamp can stay acceptable (ts may be up to one window in the
    // future, then is valid for one more), hence twice the window. Without
    // Redis we cannot tell, so refuse rather than accept a possible replay.
    let claimed: string | null;
    try {
      claimed = await this.redis.client.set(
        `leads:intake:sig:${signature.toLowerCase()}`,
        '1',
        'EX',
        Math.ceil((2 * INTAKE_REPLAY_WINDOW_MS) / 1000),
        'NX',
      );
    } catch {
      throw new ServiceUnavailableException({
        title: 'Lead intake is temporarily unavailable',
        status: 503,
      });
    }
    if (claimed !== 'OK') {
      throw new ConflictException({
        title: 'Duplicate request',
        status: 409,
        detail: 'This signed request was already received.',
        code: 'intake-replay',
      });
    }

    const notes = [data.intent?.trim(), data.page ? `(page: ${data.page})` : null]
      .filter(Boolean)
      .join(' ');

    const lead = await this.prisma.client.lead.create({
      data: {
        workspaceId,
        createdById,
        name: data.name,
        email: data.email,
        source: 'WEBSITE',
        stage: 'NEW',
        tags: ['chatbot'],
        notes: notes || undefined,
      },
    });
    return { id: lead.id };
  }

  async update(actor: SalesActor, id: string, input: UpdateLeadInput) {
    const existing = await this.get(actor, id);
    // Reassignment is an admin decision, not the assignee's. Letting an
    // assignee hand the lead on would also silently revoke their own access to
    // it mid-edit, so it's rejected outright rather than half-applied.
    if (input.assigneeId !== undefined && input.assigneeId !== existing.assigneeId) {
      this.assertFullAccess(actor, 'reassign');
    }
    if (input.assigneeId) {
      await this.assertAssigneeInOrg(actor.workspaceId, input.assigneeId);
    }
    // Whitelist explicitly to defuse future schema-drift mass-assignment.
    const updated = await this.prisma.client.lead.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.company !== undefined ? { company: input.company } : {}),
        ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.estimatedValue !== undefined ? { estimatedValue: input.estimatedValue } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        // Reset the reminder guard so a moved (or cleared) follow-up re-arms
        // the cron; a fresh date will fire again, a null won't fire at all.
        ...(input.followupAt !== undefined
          ? { followupAt: input.followupAt, followupNotifiedAt: null }
          : {}),
      },
    });
    if (
      input.assigneeId &&
      input.assigneeId !== existing.assigneeId &&
      input.assigneeId !== actor.userId
    ) {
      void this.notifications
        .emit({
          userId: input.assigneeId,
          actorId: actor.userId,
          type: 'LEAD_ASSIGNED',
          title: 'A lead was assigned to you',
          body: updated.name,
          entityType: 'lead',
          entityId: updated.id,
          url: '/leads',
        })
        .catch(() => {});
    }
    return updated;
  }

  async remove(actor: SalesActor, id: string) {
    this.assertFullAccess(actor, 'delete');
    await this.get(actor, id);
    await this.prisma.client.lead.delete({ where: { id } });
  }

  /**
   * Fire a one-off reminder for every lead whose follow-up time has arrived
   * and hasn't been notified yet. Stamped with `followupNotifiedAt` BEFORE the
   * best-effort emit so overlapping cron passes never double-notify; a missed
   * emit (rare) is preferred over spam. The recipient is the lead's assignee,
   * or the creator when the lead is unassigned. Soft-deleted leads are excluded
   * automatically by the Prisma extension.
   */
  async sweepDueFollowups(now: Date): Promise<number> {
    const due = await this.prisma.client.lead.findMany({
      where: {
        followupAt: { not: null, lte: now },
        followupNotifiedAt: null,
      },
      select: { id: true, name: true, assigneeId: true, createdById: true },
      // Bounded per pass so a large backlog can't stall the minute cron; the
      // oldest are served first and the rest fall to the next pass (they stay
      // `followupNotifiedAt: null` until then).
      orderBy: { followupAt: 'asc' },
      take: SWEEP_BATCH_SIZE,
    });
    if (due.length === 0) return 0;

    // Stamp the whole batch in one statement, still BEFORE any emit.
    await this.prisma.client.lead.updateMany({
      where: { id: { in: due.map((l) => l.id) } },
      data: { followupNotifiedAt: now },
    });
    for (const lead of due) {
      void this.notifications
        .emit({
          userId: lead.assigneeId ?? lead.createdById,
          type: 'LEAD_FOLLOWUP_DUE',
          title: 'Lead follow-up due',
          body: `Follow up with ${lead.name}`,
          entityType: 'lead',
          entityId: lead.id,
          url: '/leads',
        })
        .catch(() => {});
    }
    return due.length;
  }

  async convert(actor: SalesActor, leadId: string, input: ConvertLeadInput) {
    // Converting mints a Client, which is a create - keep it with the same
    // people who are allowed to create clients directly.
    this.assertFullAccess(actor, 'convert');
    const lead = await this.get(actor, leadId);
    const workspaceId = actor.workspaceId;
    if (input.clientId) {
      const existing = await this.prisma.client.client.findFirst({
        where: { id: input.clientId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          title: 'Client not found',
          status: 404,
          detail: 'The selected client does not belong to this workspace or has been deleted.',
        });
      }
    }
    if (!input.clientId && input.newClient?.assigneeId) {
      await this.assertAssigneeInOrg(workspaceId, input.newClient.assigneeId);
    }
    // Run client-creation + lead-update in the same transaction so a failure on
    // either side never leaves an orphan client or a half-converted lead.
    return this.prisma.client.$transaction(async (tx) => {
      let clientId = input.clientId;
      if (!clientId) {
        // The new client inherits the lead's assignee so whoever was working
        // the lead keeps seeing the account after conversion.
        const seed = input.newClient ?? {
          name: lead.company ?? lead.name,
          ...(lead.email ? { email: lead.email } : {}),
          ...(lead.phone ? { phone: lead.phone } : {}),
          ...(lead.assigneeId ? { assigneeId: lead.assigneeId } : {}),
        };
        const client = await tx.client.create({
          data: {
            workspaceId,
            createdById: actor.userId,
            name: seed.name,
            status: 'ACTIVE',
            ...(seed.email ? { email: seed.email } : {}),
            ...(seed.phone ? { phone: seed.phone } : {}),
            ...(seed.website ? { website: seed.website } : {}),
            ...(seed.notes ? { notes: seed.notes } : {}),
            ...(seed.assigneeId ? { assigneeId: seed.assigneeId } : {}),
          },
        });
        clientId = client.id;
      }
      return tx.lead.update({
        where: { id: leadId },
        data: {
          convertedToClientId: clientId,
          convertedAt: new Date(),
          stage: 'WON',
        },
      });
    });
  }
}
