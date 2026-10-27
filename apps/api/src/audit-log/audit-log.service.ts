import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  auditLogListResponseSchema,
  PLATFORM_AUDIT_ACTIONS,
  SECURITY_ALERT_ACTIONS,
  platformLogListResponseSchema,
  type AuditLogEntry,
  type AuditLogListResponse,
  type ListAuditLogQuery,
  type PlatformLogListResponse,
} from '@botss/shared-types';
import { Prisma } from '@botss/database';

import { PrismaService } from '../prisma/prisma.service';
import { userHasCompanyPermission } from '../common/permissions/effective-permissions';
import { userOrgId } from '../common/tenant-scope';

import {
  collectLookupIds,
  labelRow,
  type AuditLabelKind,
  type LabelLookups,
  type LabelRecord,
} from './audit-log-labels';

/**
 * Tenant-scoped audit log. Writes are fire-and-forget from feature code via
 * `emit(...)`; reads are always the actor's own org, plus the SUPER_ADMIN
 * platform log of organization-level events.
 *
 * Failure mode: a logging failure must NEVER fail the parent mutation -
 * the audit row is non-transactional from the caller's POV. We catch and
 * log internally so a transient DB hiccup on insert doesn't take down a
 * working API request.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a single audit event. Designed to be called from feature
   * services after the underlying mutation has committed, so a rollback
   * doesn't leave a stale audit row. The call is fire-and-forget; any
   * insert error is logged but not re-thrown.
   */
  async emit(args: {
    organizationId: string;
    actorUserId: string | null;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          organizationId: args.organizationId,
          actorUserId: args.actorUserId,
          action: args.action,
          target: args.target ?? null,
          metadata: (args.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `audit.emit failed action=${args.action} org=${args.organizationId} ` +
          `message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * List audit entries for the actor's own organization. There is no
   * cross-org parameter: SUPER_ADMIN reads only the root org's log here and
   * uses {@link listPlatform} for organization-level events.
   */
  async list(
    actingUserId: string,
    query: ListAuditLogQuery,
  ): Promise<AuditLogListResponse> {
    // The request's organization (AuthGuard's snapshot when it is this
    // user's request): in a read only support session that is the granted
    // organization, otherwise the user's own, exactly as before.
    const organizationId = await userOrgId(this.prisma, actingUserId);
    if (!(await userHasCompanyPermission(actingUserId, 'audit.view'))) {
      throw new ForbiddenException({
        title: 'Admin only',
        status: 403,
      });
    }
    const page = await this.queryPage(
      { organizationId: organizationId ?? '__none__' },
      query,
    );
    // No global response interceptor validates output, so check it here.
    return auditLogListResponseSchema.parse({
      items: page.items.map(({ row: _row, ...entry }) => entry),
      pagination: page.pagination,
    });
  }

  /**
   * SUPER_ADMIN platform log: organization-level events from every
   * organization (created, edited, suspended, restored, deleted, owner
   * invited) and nothing that happens inside one, plus security alerts
   * redacted to counts (no actor, target user or names). An `action` filter
   * outside that set matches nothing rather than widening the view.
   */
  async listPlatform(
    actingUserId: string,
    query: ListAuditLogQuery,
  ): Promise<PlatformLogListResponse> {
    const actor = await this.prisma.client.user.findUnique({
      where: { id: actingUserId },
      select: { systemRole: true },
    });
    if (actor?.systemRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException({ title: 'Super admin only', status: 403 });
    }
    const allowed: readonly string[] = PLATFORM_AUDIT_ACTIONS;
    const pool =
      query.alertsOnly === 'true'
        ? allowed.filter((a) => (SECURITY_ALERT_ACTIONS as readonly string[]).includes(a))
        : allowed;
    const actions = query.action ? pool.filter((a) => a === query.action) : [...pool];
    // No actor filter here: alert rows are about tenant users, and filtering
    // by one would reveal whose activity raised them.
    const { action: _action, alertsOnly: _alertsOnly, actorUserId: _actorUserId, ...rest } = query;
    const page = await this.queryPage({ action: { in: actions } }, rest, { searchActor: false });
    return platformLogListResponseSchema.parse({
      items: page.items.map(({ row, ...entry }) => ({
        ...redactSecurityAlert(platformSafeEntry(entry)),
        organizationName: platformOrganizationName(row, entry, page.lookups),
      })),
      pagination: page.pagination,
    });
  }

  /**
   * One page of audit rows matching `scope` plus the query filters, labelled.
   * `searchActor: false` (the platform log) keeps the actor's name and email
   * out of the free-text search so it cannot be used to find tenant users.
   */
  private async queryPage(
    scope: Prisma.AuditLogWhereInput,
    query: Omit<ListAuditLogQuery, 'action'> & { action?: string },
    options: { searchActor: boolean } = { searchActor: true },
  ) {
    const search = query.search?.trim();
    const searchOr: Prisma.AuditLogWhereInput[] = search
      ? [
          { action: { contains: search, mode: 'insensitive' } },
          // The platform log never matches alert targets (tenant user ids).
          options.searchActor
            ? { target: { contains: search, mode: 'insensitive' } }
            : {
                AND: [
                  { target: { contains: search, mode: 'insensitive' } },
                  { action: { notIn: [...SECURITY_ALERT_ACTIONS] } },
                ],
              },
          ...(options.searchActor
            ? [
                {
                  actorUser: {
                    OR: [
                      { name: { contains: search, mode: 'insensitive' as const } },
                      { email: { contains: search, mode: 'insensitive' as const } },
                    ],
                  },
                },
              ]
            : []),
        ]
      : [];
    const where: Prisma.AuditLogWhereInput = {
      ...scope,
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      // Free-text search spans the action token, the target string, and
      // (outside the platform log) the actor's name/email.
      ...(searchOr.length > 0 ? { OR: searchOr } : {}),
    };
    const skip = (query.page - 1) * query.pageSize;
    const [rows, total] = await Promise.all([
      this.prisma.client.auditLog.findMany({
        where,
        skip,
        take: query.pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          actorUser: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      }),
      this.prisma.client.auditLog.count({ where }),
    ]);

    const lookups = await this.resolveLabels(rows);
    const items = rows.map((r) => {
      const metadata = (r.metadata ?? {}) as Record<string, unknown>;
      const { targetLabel, labels } = labelRow(
        { organizationId: r.organizationId, target: r.target, metadata },
        lookups,
      );
      const entry: AuditLogEntry = {
        id: r.id,
        organizationId: r.organizationId,
        actorUserId: r.actorUserId,
        action: r.action,
        target: r.target,
        targetLabel,
        metadata,
        labels,
        createdAt: r.createdAt,
        actorUser: r.actorUser,
      };
      return { ...entry, row: r };
    });
    return {
      items,
      lookups,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize) || 1,
      },
    };
  }

  /**
   * Batch-load display names for every id a page of rows mentions: one query
   * per entity kind, never per row. Soft-deleted records are included because
   * audit rows usually outlive what they point at ("deleted Sara's access").
   * Each record carries its organization(s) so `labelRow` can refuse names
   * from other tenants.
   */
  private async resolveLabels(
    rows: ReadonlyArray<{ organizationId: string; target: string | null; metadata: unknown }>,
  ): Promise<LabelLookups> {
    const { byKind, untyped } = collectLookupIds(rows);
    // Each row's own organization, for the platform log's organization column.
    for (const row of rows) byKind.organization.add(row.organizationId);
    const idsFor = (kind: AuditLabelKind): string[] => [...new Set([...byKind[kind], ...untyped])];
    const db = this.prisma.client;

    const [users, contacts, clients, projects, documents, workspaces, roles, orgs] =
      await Promise.all([
        findManyIncludingDeleted<{
          id: string;
          name: string;
          email: string;
          organizationId: string | null;
          clientContacts: { client: { workspace: { organizationId: string } } }[];
        }>(db.user.findMany, idsFor('user'), {
          id: true,
          name: true,
          email: true,
          organizationId: true,
          // A CLIENT account has no organization; it belongs to the orgs of
          // the clients it is a contact of.
          clientContacts: {
            select: { client: { select: { workspace: { select: { organizationId: true } } } } },
          },
        }),
        findManyIncludingDeleted<{
          id: string;
          user: { name: string; email: string };
          client: { workspace: { organizationId: string } };
        }>(db.clientContact.findMany, idsFor('contact'), {
          id: true,
          user: { select: { name: true, email: true } },
          client: { select: { workspace: { select: { organizationId: true } } } },
        }),
        findManyIncludingDeleted<{ id: string; name: string; workspace: { organizationId: string } }>(
          db.client.findMany,
          idsFor('client'),
          { id: true, name: true, workspace: { select: { organizationId: true } } },
        ),
        findManyIncludingDeleted<{ id: string; name: string; workspace: { organizationId: string } }>(
          db.project.findMany,
          idsFor('project'),
          { id: true, name: true, workspace: { select: { organizationId: true } } },
        ),
        findManyIncludingDeleted<{ id: string; title: string; workspace: { organizationId: string } }>(
          db.document.findMany,
          idsFor('document'),
          { id: true, title: true, workspace: { select: { organizationId: true } } },
        ),
        findManyIncludingDeleted<{ id: string; name: string; organizationId: string }>(
          db.workspace.findMany,
          idsFor('workspace'),
          { id: true, name: true, organizationId: true },
        ),
        findManyIncludingDeleted<{ id: string; name: string; organizationId: string }>(
          db.role.findMany,
          idsFor('role'),
          { id: true, name: true, organizationId: true },
        ),
        findManyIncludingDeleted<{ id: string; name: string }>(
          db.organization.findMany,
          idsFor('organization'),
          { id: true, name: true },
        ),
      ]);

    const toMap = <T extends { id: string }>(
      list: T[],
      label: (row: T) => LabelRecord,
    ): Map<string, LabelRecord> => new Map(list.map((row) => [row.id, label(row)]));

    return {
      user: toMap(users, (u) => ({
        name: u.name || u.email,
        orgIds: [
          ...(u.organizationId ? [u.organizationId] : []),
          ...u.clientContacts.map((c) => c.client.workspace.organizationId),
        ],
      })),
      contact: toMap(contacts, (c) => ({
        name: c.user.name || c.user.email,
        orgIds: [c.client.workspace.organizationId],
      })),
      client: toMap(clients, (c) => ({ name: c.name, orgIds: [c.workspace.organizationId] })),
      project: toMap(projects, (p) => ({ name: p.name, orgIds: [p.workspace.organizationId] })),
      document: toMap(documents, (d) => ({
        name: d.title,
        orgIds: [d.workspace.organizationId],
      })),
      workspace: toMap(workspaces, (w) => ({ name: w.name, orgIds: [w.organizationId] })),
      role: toMap(roles, (r) => ({ name: r.name, orgIds: [r.organizationId] })),
      organization: toMap(orgs, (o) => ({ name: o.name, orgIds: [o.id] })),
    };
  }
}

const SECURITY_ALERT_SET: ReadonlySet<string> = new Set(SECURITY_ALERT_ACTIONS);

/**
 * A security alert in the platform log says what happened in which
 * organization, never who: the actor, the target user, the resolved names and
 * the metadata user id all belong to the tenant. Other rows pass through.
 */
function redactSecurityAlert<T extends AuditLogEntry>(entry: T): T {
  if (!SECURITY_ALERT_SET.has(entry.action)) return entry;
  const { userId: _userId, ...metadata } = entry.metadata;
  return {
    ...entry,
    actorUserId: null,
    actorUser: null,
    target: null,
    targetLabel: null,
    labels: {},
    metadata,
  };
}

/**
 * What the platform log may show of an entry. Support grant events are
 * written inside the organization by its own admins, so for those the
 * platform log keeps only the organization, the end time and the read only
 * flag: no actor (a person of another organization), no other metadata.
 * Every other platform action is unchanged.
 */
export function platformSafeEntry(entry: AuditLogEntry): AuditLogEntry {
  if (!entry.action.startsWith('support.')) return entry;
  const metadata: Record<string, unknown> = {};
  if (typeof entry.metadata['expiresAt'] === 'string') metadata['expiresAt'] = entry.metadata['expiresAt'];
  if (typeof entry.metadata['readOnly'] === 'boolean') metadata['readOnly'] = entry.metadata['readOnly'];
  return {
    ...entry,
    actorUserId: null,
    actorUser: null,
    metadata,
    labels: {},
  };
}

/**
 * The organization a platform-log row is about. Usually the row's own org;
 * `org.hard_delete` rows live in the root org (the purged org row is gone),
 * so for an organization target prefer the target, then the name recorded in
 * the metadata at delete time.
 */
function platformOrganizationName(
  row: { organizationId: string },
  entry: Pick<AuditLogEntry, 'targetLabel' | 'metadata'>,
  lookups: LabelLookups,
): string | null {
  if (entry.targetLabel?.type === 'organization') {
    if (entry.targetLabel.name) return entry.targetLabel.name;
    const recorded = entry.metadata['name'];
    return typeof recorded === 'string' ? recorded : null;
  }
  return lookups.organization.get(row.organizationId)?.name ?? null;
}

/**
 * `findMany({ where: { id: { in: ids } }, select, includeDeleted: true })` on a
 * soft-delete model. The extension accepts `includeDeleted` but Prisma's
 * generated types don't know it, hence the cast (same pattern as
 * `FilesService.getObjectBuffer`). Skips the query when there is nothing to
 * look up.
 */
async function findManyIncludingDeleted<T>(
  findMany: unknown,
  ids: string[],
  select: Record<string, unknown>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  return (findMany as (args: unknown) => Promise<T[]>)({
    where: { id: { in: ids } },
    select,
    includeDeleted: true,
  });
}
