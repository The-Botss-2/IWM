import { Injectable } from '@nestjs/common';
import {
  type ClientActivityKind,
  clientActivityListSchema,
  type ClientActivityList,
  type ClientHubPageQuery,
} from '@botss/shared-types';

import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { projectAccessWhere } from '../common/project-access';
import { clientContractWhere, clientPaymentWhere } from '../finance/client-finance-where';
import { LIVE_PAYMENT, money } from '../finance/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { signatureVisibleWhere } from '../signatures/signature-visibility';
import {
  clientSignatureRelationWhere,
  decodeCursor,
  documentReadWhere,
  type FeedCursor,
  type FeedEntry,
  feedEntry,
  keysetWhere,
  mergeFeed,
} from './client-hub-rules';
import { requireVisibleClient } from './client-visibility';

/** Portal actions the feed shows, by AuditLog action token. */
const PORTAL_ACTIONS: Record<string, ClientActivityKind> = {
  'client.portal.invite': 'PORTAL_INVITED',
  'client.portal.revoke': 'PORTAL_REVOKED',
  'client.portal.role': 'PORTAL_ROLE_CHANGED',
};

const ACTOR = { select: { id: true, name: true } } as const;

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

/**
 * A client's Activity tab, derived from the tables that already record what
 * happened (no event table, so history shows up immediately).
 *
 * Every source applies the same rule as the place the item comes from:
 * projects through `projectAccessWhere`, documents through the document read
 * rule, signatures through `signatureVisibleWhere`, and invoices, payments
 * and contracts only for finance roles (decided here, never by the caller).
 *
 * Paging: each source is one bounded, index-backed keyset query of at most
 * `limit + 1` rows; `mergeFeed` takes the newest `limit` of the union. About
 * ten queries per page, none per row.
 */
@Injectable()
export class ClientActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    scope: UserScope,
    actor: SalesActor,
    clientId: string,
    query: ClientHubPageQuery,
  ): Promise<ClientActivityList> {
    const client = await requireVisibleClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({
        where,
        select: {
          id: true,
          name: true,
          workspaceId: true,
          createdAt: true,
          createdBy: ACTOR,
          convertedFrom: { select: { id: true, name: true, convertedAt: true } },
          workspace: { select: { organizationId: true } },
          // Nested relation reads skip the soft-delete filter: revoked people
          // stay matched, so their signature history and portal events keep a
          // name.
          contacts: { select: { id: true, user: { select: { name: true, email: true } } } },
        },
      }),
    );
    const cursor = decodeCursor(query.cursor);
    const take = query.limit + 1;
    const workspaceId = client.workspaceId;
    const viewer = { userId: actor.userId, workspaceRole: scope.workspaceRole };
    const contactById = new Map(client.contacts.map((c) => [c.id, c.user]));
    const contactEmails = client.contacts.map((c) => c.user.email);

    const sources: Array<Promise<FeedEntry[]>> = [
      Promise.resolve(this.recordEntries(client)),
      this.projects(scope, client.id, workspaceId, cursor, take),
      this.filedDocuments(viewer, client.id, workspaceId, cursor, take),
      this.documentShares(viewer, client.id, workspaceId, cursor, take),
      this.portalEvents(client.workspace.organizationId, client.id, contactById, cursor, take),
      ...this.signatureEntries(
        { userId: actor.userId, workspaceId, workspaceRole: scope.workspaceRole },
        client.id,
        contactEmails,
        cursor,
        take,
      ),
    ];
    if (actor.financeAccess) {
      sources.push(
        this.invoices(client.id, workspaceId, cursor, take),
        this.payments(client.id, workspaceId, cursor, take),
        this.contracts(client.id, workspaceId, cursor, take),
      );
    }
    const merged = mergeFeed(await Promise.all(sources), query.limit, cursor);
    return clientActivityListSchema.parse(merged);
  }

  // ---- Sources -------------------------------------------------------------

  /** Client created, and the lead it was converted from (from the row itself). */
  private recordEntries(client: {
    id: string;
    name: string;
    createdAt: Date;
    createdBy: { id: string; name: string };
    convertedFrom: { id: string; name: string; convertedAt: Date | null } | null;
  }): FeedEntry[] {
    const out = [
      feedEntry('client', client.id, client.createdAt, {
        kind: 'CLIENT_CREATED',
        actor: client.createdBy,
        title: client.name,
        detail: null,
        entity: { type: 'client', id: client.id },
      }),
    ];
    const lead = client.convertedFrom;
    if (lead?.convertedAt) {
      out.push(
        feedEntry('lead', lead.id, lead.convertedAt, {
          kind: 'LEAD_CONVERTED',
          actor: null,
          title: lead.name,
          detail: null,
          entity: { type: 'lead', id: lead.id },
        }),
      );
    }
    return out;
  }

  private async projects(
    scope: UserScope,
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.project.findMany({
      where: {
        AND: [
          { clientId, workspaceId, deletedAt: null },
          projectAccessWhere(scope),
          keysetWhere('project', 'createdAt', cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, name: true, createdAt: true, createdBy: ACTOR },
    });
    return rows.map((r) =>
      feedEntry('project', r.id, r.createdAt, {
        kind: 'PROJECT_CREATED',
        actor: r.createdBy,
        title: r.name,
        detail: null,
        entity: { type: 'project', id: r.id },
      }),
    );
  }

  /** Documents filed under the client. There is no "filed at" column, so a
   *  document appears at its creation time. */
  private async filedDocuments(
    viewer: { userId: string; workspaceRole: string | null },
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.document.findMany({
      where: {
        AND: [
          { clientId, workspaceId, deletedAt: null },
          documentReadWhere(viewer),
          keysetWhere('docfiled', 'createdAt', cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, title: true, createdAt: true, createdBy: ACTOR },
    });
    return rows.map((r) =>
      feedEntry('docfiled', r.id, r.createdAt, {
        kind: 'DOCUMENT_FILED',
        actor: r.createdBy,
        title: r.title,
        detail: null,
        entity: { type: 'document', id: r.id },
      }),
    );
  }

  /** Documents shared with the whole client company. */
  private async documentShares(
    viewer: { userId: string; workspaceRole: string | null },
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.documentClientShare.findMany({
      where: {
        AND: [
          {
            clientId,
            // Nested: soft-delete is only filtered at the top level.
            document: { AND: [{ workspaceId, deletedAt: null }, documentReadWhere(viewer)] },
          },
          keysetWhere('docshare', 'createdAt', cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        createdAt: true,
        grantedBy: ACTOR,
        document: { select: { id: true, title: true } },
      },
    });
    return rows.map((r) =>
      feedEntry('docshare', r.id, r.createdAt, {
        kind: 'DOCUMENT_SHARED',
        actor: r.grantedBy,
        title: r.document.title,
        detail: null,
        entity: { type: 'document', id: r.document.id },
      }),
    );
  }

  /** Portal invites, revocations and role changes, from the audit log. */
  private async portalEvents(
    organizationId: string,
    clientId: string,
    contactById: Map<string, { name: string; email: string }>,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.auditLog.findMany({
      where: {
        AND: [
          {
            organizationId,
            target: `client:${clientId}`,
            action: { in: Object.keys(PORTAL_ACTIONS) },
          },
          keysetWhere('audit', 'createdAt', cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, action: true, createdAt: true, metadata: true, actorUser: ACTOR },
    });
    return rows.flatMap((r) => {
      const kind = PORTAL_ACTIONS[r.action];
      if (!kind) return [];
      const contactId = metaString(r.metadata, 'contactId');
      const person = contactId ? contactById.get(contactId) : undefined;
      const email = metaString(r.metadata, 'email') ?? person?.email ?? null;
      const role = metaString(r.metadata, 'role');
      return [
        feedEntry('audit', r.id, r.createdAt, {
          kind,
          actor: r.actorUser,
          title: person?.name ?? email ?? 'Client portal person',
          detail: kind === 'PORTAL_REVOKED' ? email : (role ?? email),
          entity: contactId ? { type: 'portal_contact', id: contactId } : null,
        }),
      ];
    });
  }

  /** Signature requests sent and completed, as two keyset sources. */
  private signatureEntries(
    sigActor: { userId: string; workspaceId: string; workspaceRole: string | null },
    clientId: string,
    contactEmails: readonly string[],
    cursor: FeedCursor | null,
    take: number,
  ): Array<Promise<FeedEntry[]>> {
    const base = [
      signatureVisibleWhere(sigActor),
      clientSignatureRelationWhere(clientId, contactEmails),
    ];
    const one = async (
      source: 'sigsent' | 'sigdone',
      field: 'sentAt' | 'completedAt',
      kind: ClientActivityKind,
    ): Promise<FeedEntry[]> => {
      const rows = await this.prisma.client.signatureRequest.findMany({
        where: {
          AND: [...base, { [field]: { not: null } }, keysetWhere(source, field, cursor)],
        },
        orderBy: [{ [field]: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true,
          title: true,
          sentAt: true,
          completedAt: true,
          createdBy: ACTOR,
          _count: { select: { signers: true } },
        },
      });
      return rows.flatMap((r) => {
        const at = r[field];
        if (!at) return [];
        return [
          feedEntry(source, r.id, at, {
            kind,
            // Completion is the last signer's act, not the requester's.
            actor: kind === 'SIGNATURE_SENT' ? r.createdBy : null,
            title: r.title,
            detail: `${r._count.signers} signer${r._count.signers === 1 ? '' : 's'}`,
            entity: { type: 'signature', id: r.id },
          }),
        ];
      });
    };
    return [
      one('sigsent', 'sentAt', 'SIGNATURE_SENT'),
      one('sigdone', 'completedAt', 'SIGNATURE_COMPLETED'),
    ];
  }

  // ---- Finance sources (finance roles only) ---------------------------------

  private async invoices(
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.invoice.findMany({
      where: {
        AND: [
          { clientId, workspaceId, deletedAt: null, status: { not: 'DRAFT' } },
          keysetWhere('invoice', 'issuedAt', cursor),
        ],
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        number: true,
        issuedAt: true,
        currency: true,
        total: true,
        createdBy: ACTOR,
      },
    });
    return rows.map((r) =>
      feedEntry('invoice', r.id, r.issuedAt, {
        kind: 'INVOICE_ISSUED',
        actor: r.createdBy,
        title: r.number,
        detail: `${r.currency} ${money(r.total)}`,
        entity: { type: 'invoice', id: r.id },
      }),
    );
  }

  private async payments(
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.payment.findMany({
      where: {
        AND: [
          { workspaceId, ...LIVE_PAYMENT },
          clientPaymentWhere(clientId),
          keysetWhere('payment', 'paidAt', cursor),
        ],
      },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        paidAt: true,
        currency: true,
        amount: true,
        recordedBy: ACTOR,
        invoice: { select: { number: true } },
        contract: { select: { title: true } },
      },
    });
    return rows.map((r) =>
      feedEntry('payment', r.id, r.paidAt, {
        kind: 'PAYMENT_RECEIVED',
        actor: r.recordedBy,
        title: r.invoice?.number ?? r.contract?.title ?? 'Payment',
        detail: `${r.currency} ${money(r.amount)}`,
        entity: { type: 'payment', id: r.id },
      }),
    );
  }

  private async contracts(
    clientId: string,
    workspaceId: string,
    cursor: FeedCursor | null,
    take: number,
  ): Promise<FeedEntry[]> {
    const rows = await this.prisma.client.contract.findMany({
      where: {
        AND: [
          { workspaceId, deletedAt: null },
          clientContractWhere(clientId),
          keysetWhere('contract', 'createdAt', cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        title: true,
        createdAt: true,
        currency: true,
        totalValue: true,
        createdBy: ACTOR,
      },
    });
    return rows.map((r) =>
      feedEntry('contract', r.id, r.createdAt, {
        kind: 'CONTRACT_CREATED',
        actor: r.createdBy,
        title: r.title,
        detail: `${r.currency} ${money(r.totalValue)}`,
        entity: { type: 'contract', id: r.id },
      }),
    );
  }
}
