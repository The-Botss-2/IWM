import { Injectable, NotFoundException } from '@nestjs/common';
import {
  portalDocumentListSchema,
  portalDocumentSchema,
  type PortalDocument,
  type PortalDocumentList,
} from '@botss/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import { portalDocumentWhere } from './portal-rules';
import { PortalScopeService, type PortalContact } from './portal-scope';

/** Most documents a portal list returns. */
const LIST_LIMIT = 200;

/** Read-only documents shared with a client company or one of its people. */
@Injectable()
export class PortalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: PortalScopeService,
  ) {}

  async list(userId: string, clientId: string): Promise<PortalDocumentList> {
    const contact = await this.scope.require(userId, clientId);
    const docs = await this.prisma.client.document.findMany({
      where: portalDocumentWhere(contact, userId),
      orderBy: { updatedAt: 'desc' },
      take: LIST_LIMIT,
      select: {
        id: true,
        title: true,
        icon: true,
        updatedAt: true,
        clientShares: { where: { clientId: contact.clientId }, select: { id: true } },
      },
    });
    return portalDocumentListSchema.parse({
      items: docs.map((d) => ({
        id: d.id,
        title: d.title,
        icon: d.icon,
        updatedAt: d.updatedAt,
        sharedWith: d.clientShares.length > 0 ? 'COMPANY' : 'PERSON',
      })),
    });
  }

  async get(userId: string, clientId: string, documentId: string): Promise<PortalDocument> {
    const contact = await this.scope.require(userId, clientId);
    const doc = await this.prisma.client.document.findFirst({
      where: { id: documentId, ...portalDocumentWhere(contact, userId) },
      select: {
        id: true,
        title: true,
        icon: true,
        coverUrl: true,
        content: true,
        updatedAt: true,
        createdBy: { select: { name: true } },
      },
    });
    if (!doc) {
      throw new NotFoundException({ title: 'Document not found', status: 404 });
    }
    return portalDocumentSchema.parse({
      id: doc.id,
      title: doc.title,
      icon: doc.icon,
      coverUrl: doc.coverUrl,
      content: doc.content,
      authorName: doc.createdBy.name,
      updatedAt: doc.updatedAt,
    });
  }

  /** For the overview. */
  count(contact: PortalContact, userId: string): Promise<number> {
    return this.prisma.client.document.count({ where: portalDocumentWhere(contact, userId) });
  }
}
