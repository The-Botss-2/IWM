import { Injectable } from '@nestjs/common';
import { clientDocumentListSchema, type ClientDocumentList } from '@botss/shared-types';

import {
  clientDocumentLinks,
  clientDocumentRelationWhere,
  documentReadWhere,
  documentViewerPermission,
  isWorkspaceAdminRole,
} from '../clients/client-hub-rules';
import { requireVisibleClient } from '../clients/client-visibility';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import type { UserScope } from '../common/decorators/user-scope.decorator';
import { canSeeProject } from '../common/project-access';
import { PrismaService } from '../prisma/prisma.service';

/** Upper bound on one client's document list; `hasMore` says when it bites. */
const LIST_LIMIT = 200;

/**
 * The Documents tab of a client: documents the viewer can already read
 * (creator, workspace admin, explicit grant) that belong to the client.
 * Listing never widens document access - a document the viewer cannot open
 * elsewhere is not listed here either.
 */
@Injectable()
export class ClientDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(scope: UserScope, actor: SalesActor, clientId: string): Promise<ClientDocumentList> {
    const client = await requireVisibleClient(actor, clientId, (where) =>
      this.prisma.client.client.findFirst({
        where,
        select: {
          id: true,
          workspaceId: true,
          contacts: {
            where: { deletedAt: null, user: { deletedAt: null } },
            select: { userId: true },
          },
        },
      }),
    );
    const viewer = { userId: actor.userId, workspaceRole: scope.workspaceRole };
    const contactUserIds = client.contacts.map((c) => c.userId);

    const rows = await this.prisma.client.document.findMany({
      where: {
        AND: [
          { workspaceId: client.workspaceId, deletedAt: null },
          documentReadWhere(viewer),
          clientDocumentRelationWhere(client.id, contactUserIds),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT + 1,
      select: {
        id: true,
        title: true,
        icon: true,
        visibility: true,
        clientId: true,
        projectId: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        project: {
          select: {
            id: true,
            name: true,
            visibility: true,
            createdById: true,
            clientId: true,
            deletedAt: true,
          },
        },
        clientShares: { where: { clientId: client.id }, select: { id: true } },
        // The viewer's own grant and the client people's grants, in one go.
        access: {
          where: { userId: { in: [actor.userId, ...contactUserIds] } },
          select: { userId: true, permission: true },
        },
      },
    });

    const contactSet = new Set(contactUserIds);
    const isAdmin = isWorkspaceAdminRole(scope.workspaceRole);
    const items = rows.slice(0, LIST_LIMIT).map((d) => {
      const liveProject = d.project && d.project.deletedAt === null ? d.project : null;
      const peopleShared = d.access.filter((a) => contactSet.has(a.userId)).length;
      const companyShared = d.clientShares.length > 0;
      const links = clientDocumentLinks(client.id, {
        clientId: d.clientId,
        projectClientId: liveProject?.clientId ?? null,
        companyShared,
        peopleShared,
      });
      const own = d.access.find((a) => a.userId === actor.userId);
      return {
        id: d.id,
        title: d.title,
        icon: d.icon,
        visibility: d.visibility,
        clientId: d.clientId,
        projectId: d.projectId,
        project: liveProject
          ? {
              id: liveProject.id,
              name: canSeeProject(scope, liveProject) ? liveProject.name : null,
            }
          : null,
        createdBy: d.createdBy,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        // The where-clause guarantees at least one link.
        link: links[0] ?? 'SHARED',
        links,
        sharedWithClient: companyShared,
        sharedWithPeopleCount: peopleShared,
        viewerPermission: documentViewerPermission(viewer, d, own?.permission ?? null),
        canManageShare: d.createdById === actor.userId || isAdmin,
      };
    });
    return clientDocumentListSchema.parse({ items, hasMore: rows.length > LIST_LIMIT });
  }
}
