import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@botss/database';
import type {
  AddDocumentAccessInput,
  AddDocumentClientShareInput,
  CreateDocumentInput,
  DocumentClientShare,
  DocumentPermission,
  DocumentShareTargets,
  DocumentViewerPermission,
  ListDocumentsQuery,
  UpdateDocumentAccessInput,
  UpdateDocumentInput,
} from '@botss/shared-types';
import {
  documentClientShareSchema,
  documentShareTargetsSchema,
  tiptapToText,
} from '@botss/shared-types';
import { randomBytes } from 'node:crypto';

import { AuditLogService } from '../audit-log/audit-log.service';
import type { SalesActor } from '../common/decorators/sales-actor.decorator';
import { orgWorkspaceMembership } from '../common/tenant-scope';
import { livePortalContactWhere } from '../portal/portal-scope';
import { PrismaService } from '../prisma/prisma.service';

const ACCESS_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  image: true,
  accountType: true,
} as const;

const CLIENT_SHARE_SELECT = {
  id: true,
  documentId: true,
  clientId: true,
  createdAt: true,
  client: { select: { id: true, name: true } },
  grantedBy: { select: { id: true, name: true } },
} as const;

interface DocumentAccessContext {
  userId: string;
  workspaceRole: string | undefined;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Derives the viewer's effective permission on a document - used to gate
   *  edits server-side and to surface the read-only banner client-side. */
  private async viewerPermission(
    workspaceId: string,
    docId: string,
    ctx: DocumentAccessContext,
  ): Promise<DocumentViewerPermission | null> {
    const doc = await this.prisma.client.document.findFirst({
      where: { id: docId, workspaceId },
      select: { createdById: true },
    });
    if (!doc) return null;
    if (doc.createdById === ctx.userId) return 'OWNER';
    if (ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN') return 'ADMIN';
    const grant = await this.prisma.client.documentAccess.findUnique({
      where: { documentId_userId: { documentId: docId, userId: ctx.userId } },
      select: { permission: true },
    });
    if (grant?.permission === 'WRITE') return 'WRITE';
    if (grant?.permission === 'READ') return 'READ';
    return null;
  }

  /**
   * Throws unless the caller can read (`'read'`) or edit (`'write'`) the
   * document. Used by other modules (e-signature) that act on a document
   * without going through this controller.
   */
  async assertAccess(
    workspaceId: string,
    documentId: string,
    ctx: DocumentAccessContext,
    level: 'read' | 'write',
  ): Promise<DocumentViewerPermission> {
    const permission = await this.viewerPermission(workspaceId, documentId, ctx);
    if (!permission) {
      throw new NotFoundException({ title: 'Document not found', status: 404 });
    }
    if (level === 'write' && permission === 'READ') {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'You need edit access to this document.',
      });
    }
    return permission;
  }

  async list(workspaceId: string, q: ListDocumentsQuery, ctx: DocumentAccessContext) {
    // Visibility-based access + explicit DocumentAccess grants. The OR shape
    // surfaces docs the user can normally see *plus* docs explicitly shared
    // with them in this workspace.
    const baseWhere: Record<string, unknown> = { workspaceId };
    if (q.search) {
      baseWhere['title'] = { contains: q.search, mode: 'insensitive' };
    }
    if (q.projectId) baseWhere['projectId'] = q.projectId;
    if (q.parentId !== undefined) baseWhere['parentId'] = q.parentId;
    if (q.visibility) baseWhere['visibility'] = q.visibility;

    const isAdmin = ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN';
    // Documents default to private. Regular workspace members see only
    // (a) docs they created, or (b) docs explicitly shared with them via
    // DocumentAccess. The legacy `visibility` enum (WORKSPACE/PROJECT)
    // no longer grants implicit read - that broadcast model was at odds
    // with how the team actually uses docs (most are personal-but-in-
    // a-workspace). Workspace OWNER/ADMIN keep cross-doc visibility for
    // moderation.
    const accessFilter: Record<string, unknown> = isAdmin
      ? {}
      : {
          OR: [
            { createdById: ctx.userId },
            { access: { some: { userId: ctx.userId } } },
          ],
        };

    const where = isAdmin ? baseWhere : { AND: [baseWhere, accessFilter] };

    const skip = (q.page - 1) * q.pageSize;
    const [items, total] = await Promise.all([
      this.prisma.client.document.findMany({
        where,
        skip,
        take: q.pageSize,
        orderBy: { [q.sort]: q.order },
        // Every column except `contentText`, the search-only plain-text copy of
        // `content` (it doubled each row's payload and isn't in the response
        // schema). `content` stays: the documents page opens the editor from
        // the list item.
        select: {
          id: true,
          workspaceId: true,
          projectId: true,
          clientId: true,
          createdById: true,
          parentId: true,
          title: true,
          icon: true,
          coverUrl: true,
          visibility: true,
          content: true,
          publicSlug: true,
          publicReadOnly: true,
          publicExpiresAt: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          createdBy: { select: { id: true, name: true, email: true, image: true } },
          access: {
            where: { userId: ctx.userId },
            select: { permission: true },
            take: 1,
          },
          _count: { select: { access: true } },
        },
      }),
      this.prisma.client.document.count({ where }),
    ]);

    const enriched = items.map((d) => {
      let viewerPermission: DocumentViewerPermission;
      if (d.createdById === ctx.userId) viewerPermission = 'OWNER';
      else if (isAdmin) viewerPermission = 'ADMIN';
      else if (d.access[0]?.permission === 'WRITE') viewerPermission = 'WRITE';
      else if (d.access[0]?.permission === 'READ') viewerPermission = 'READ';
      else viewerPermission = 'READ';
      const { access: _drop, _count, ...rest } = d;
      return { ...rest, viewerPermission, accessGrantCount: _count.access };
    });

    return {
      items: enriched,
      pagination: {
        page: q.page,
        pageSize: q.pageSize,
        total,
        totalPages: Math.ceil(total / q.pageSize) || 1,
      },
    };
  }

  async get(workspaceId: string, id: string, ctx: DocumentAccessContext) {
    const doc = await this.prisma.client.document.findFirst({
      where: { id, workspaceId },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        _count: { select: { access: true } },
      },
    });
    if (!doc) throw new NotFoundException({ title: 'Document not found', status: 404 });
    // Read access: creator always; workspace OWNER/ADMIN always (for
    // moderation); otherwise an explicit DocumentAccess row is required.
    // PUBLIC_LINK retains the special meaning that the doc is reachable
    // via its shareable URL (handled by a separate `/p/[slug]` route);
    // it no longer implies an in-app read for non-shared members.
    const isAdmin = ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN';
    const isCreator = doc.createdById === ctx.userId;
    let viewerPermission: DocumentViewerPermission;
    if (isCreator) viewerPermission = 'OWNER';
    else if (isAdmin) viewerPermission = 'ADMIN';
    else {
      const grant = await this.prisma.client.documentAccess.findUnique({
        where: { documentId_userId: { documentId: id, userId: ctx.userId } },
        select: { permission: true },
      });
      if (grant?.permission === 'WRITE') viewerPermission = 'WRITE';
      else if (grant?.permission === 'READ') viewerPermission = 'READ';
      else {
        throw new ForbiddenException({
          title: 'Forbidden',
          status: 403,
          detail: 'You no longer have access to this document.',
        });
      }
    }
    const { _count, ...rest } = doc;
    return { ...rest, viewerPermission, accessGrantCount: _count.access };
  }

  async create(workspaceId: string, userId: string, input: CreateDocumentInput) {
    await this.assertWorkspaceRefs(workspaceId, {
      parentId: input.parentId,
      projectId: input.projectId,
      clientId: input.clientId,
    });
    return this.prisma.client.document.create({
      data: {
        workspaceId,
        createdById: userId,
        title: input.title,
        visibility: input.visibility ?? 'WORKSPACE',
        projectId: input.projectId,
        // Filing only: it does not share the document with the client.
        clientId: input.clientId,
        parentId: input.parentId,
        icon: input.icon,
        coverUrl: input.coverUrl,
        content:
          input.content === undefined ? undefined : (input.content as Prisma.InputJsonValue),
        // Plain-text copy of the content, kept in step on every write so
        // search can match inside documents, not only titles.
        contentText: input.content === undefined ? undefined : tiptapToText(input.content),
      },
    });
  }

  /**
   * Ensures referenced parent document and project both live inside the caller's
   * workspace. Prevents cross-tenant document re-parenting or sneaking a
   * foreign-project link through the create/update payload.
   */
  private async assertWorkspaceRefs(
    workspaceId: string,
    refs: { parentId?: string | null; projectId?: string | null; clientId?: string | null },
  ): Promise<void> {
    if (refs.clientId) {
      const client = await this.prisma.client.client.findFirst({
        where: { id: refs.clientId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!client) {
        throw new NotFoundException({
          title: 'Client not found',
          status: 404,
          detail: 'The selected client does not belong to this workspace.',
        });
      }
    }
    if (refs.parentId) {
      const parent = await this.prisma.client.document.findFirst({
        where: { id: refs.parentId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) {
        throw new NotFoundException({
          title: 'Parent document not found',
          status: 404,
          detail: 'The selected parent document does not belong to this workspace.',
        });
      }
    }
    if (refs.projectId) {
      const project = await this.prisma.client.project.findFirst({
        where: { id: refs.projectId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!project) {
        throw new NotFoundException({
          title: 'Project not found',
          status: 404,
          detail: 'The selected project does not belong to this workspace.',
        });
      }
    }
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateDocumentInput,
    ctx: DocumentAccessContext,
  ) {
    // Read-gate (also enforces existence). We then check write permission.
    const doc = await this.get(workspaceId, id, ctx);
    if (doc.viewerPermission === 'READ') {
      throw new ForbiddenException({
        title: 'Read-only',
        status: 403,
        detail: 'You only have read access to this document.',
      });
    }
    await this.assertWorkspaceRefs(workspaceId, {
      parentId: input.parentId ?? null,
      projectId: input.projectId ?? null,
      clientId: input.clientId ?? null,
    });
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'projectId', 'clientId', 'parentId', 'icon', 'coverUrl', 'visibility', 'publicReadOnly'] as const) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined) data[k] = v;
    }
    if (input.content !== undefined) {
      data['content'] = input.content as Prisma.InputJsonValue;
      data['contentText'] = tiptapToText(input.content);
    }
    if (input.publicExpiresAt !== undefined) {
      if (input.publicExpiresAt && input.publicExpiresAt.getTime() <= Date.now()) {
        throw new BadRequestException({ title: 'Expiry must be in the future', status: 400 });
      }
      data['publicExpiresAt'] = input.publicExpiresAt;
    }
    return this.prisma.client.document.update({ where: { id }, data });
  }

  async remove(workspaceId: string, id: string, ctx: DocumentAccessContext) {
    // Only owners/admins can delete. Writers can edit but not destroy.
    const doc = await this.get(workspaceId, id, ctx);
    if (doc.viewerPermission !== 'OWNER' && doc.viewerPermission !== 'ADMIN') {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the document owner or a workspace admin can delete a document.',
      });
    }
    await this.prisma.client.document.delete({ where: { id } });
  }

  /**
   * Generate a random public slug and enable public-link sharing. Re-sharing
   * rotates the slug, which is also how an owner revokes a leaked link.
   */
  async sharePublic(
    workspaceId: string,
    id: string,
    publicReadOnly: boolean,
    ctx: DocumentAccessContext,
    expiresAt: Date | null = null,
  ) {
    await this.ensureCanManageShare(workspaceId, id, ctx);
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        title: 'Expiry must be in the future',
        status: 400,
      });
    }
    const slug = randomBytes(9).toString('base64url'); // 12 chars
    return this.prisma.client.document.update({
      where: { id },
      data: {
        publicSlug: slug,
        publicReadOnly,
        visibility: 'PUBLIC_LINK',
        publicExpiresAt: expiresAt,
      },
    });
  }

  async unshare(workspaceId: string, id: string, ctx: DocumentAccessContext) {
    await this.ensureCanManageShare(workspaceId, id, ctx);
    const doc = await this.prisma.client.document.findFirstOrThrow({
      where: { id, workspaceId },
      select: { projectId: true },
    });
    // Restore to a sensible scope based on whether the doc was project-linked
    // when shared. Without storing the pre-share visibility we can't perfectly
    // reverse it, but this never accidentally widens a project-scoped doc to
    // workspace-wide on revoke.
    const nextVisibility = doc.projectId ? 'PROJECT' : 'WORKSPACE';
    return this.prisma.client.document.update({
      where: { id },
      data: { publicSlug: null, visibility: nextVisibility, publicExpiresAt: null },
    });
  }

  async getByPublicSlug(slug: string) {
    const doc = await this.prisma.client.document.findFirst({
      where: {
        publicSlug: slug,
        visibility: 'PUBLIC_LINK',
        // An archived (soft-deleted) or suspended tenant, or a deleted
        // workspace, stops serving its public links. Relation filters are
        // not covered by the soft-delete extension, so spell them out.
        workspace: {
          deletedAt: null,
          organization: { deletedAt: null, isActive: true },
        },
      },
      include: {
        workspace: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
    });
    // An expired link answers exactly like a revoked one.
    if (!doc || (doc.publicExpiresAt && doc.publicExpiresAt.getTime() <= Date.now())) {
      throw new NotFoundException({ title: 'Document not found', status: 404 });
    }
    return {
      title: doc.title,
      content: doc.content,
      workspaceName: doc.workspace.name,
      authorName: doc.createdBy.name,
      publicReadOnly: doc.publicReadOnly,
      updatedAt: doc.updatedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Access management (Task 6 - internal sharing)
  // -------------------------------------------------------------------------

  /** Confirm the caller is allowed to add/remove/edit grants on a doc. */
  private async ensureCanManageShare(
    workspaceId: string,
    documentId: string,
    ctx: DocumentAccessContext,
  ): Promise<{ ownerId: string }> {
    const doc = await this.prisma.client.document.findFirst({
      where: { id: documentId, workspaceId },
      select: { createdById: true },
    });
    if (!doc) throw new NotFoundException({ title: 'Document not found', status: 404 });
    const isAdmin = ctx.workspaceRole === 'OWNER' || ctx.workspaceRole === 'ADMIN';
    if (doc.createdById !== ctx.userId && !isAdmin) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Only the document owner or a workspace admin can manage sharing.',
      });
    }
    return { ownerId: doc.createdById };
  }

  async listAccess(workspaceId: string, documentId: string, ctx: DocumentAccessContext) {
    // Anyone who can read the doc can see who else has access (transparency
    // matters for an internal collaboration tool - surprise viewers are an
    // anti-pattern).
    const doc = await this.get(workspaceId, documentId, ctx);
    const [items, owner, clientShares] = await Promise.all([
      this.prisma.client.documentAccess.findMany({
        where: { documentId },
        orderBy: { createdAt: 'asc' },
        include: {
          // accountType tells the dialog which people are client-portal
          // people (read-only, never offered Write).
          user: { select: ACCESS_USER_SELECT },
          grantedBy: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      this.prisma.client.user.findUniqueOrThrow({
        where: { id: doc.createdById },
        select: { id: true, name: true, email: true, image: true },
      }),
      this.prisma.client.documentClientShare.findMany({
        where: { documentId, client: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        select: CLIENT_SHARE_SELECT,
      }),
    ]);
    return { items, owner, clientShares };
  }

  async addAccess(
    workspaceId: string,
    documentId: string,
    input: AddDocumentAccessInput,
    ctx: DocumentAccessContext,
  ) {
    const { ownerId } = await this.ensureCanManageShare(workspaceId, documentId, ctx);
    if (input.userId === ownerId) {
      throw new ForbiddenException({
        title: 'Invalid grant',
        status: 403,
        detail: 'The document owner already has full access.',
      });
    }
    const target = await this.prisma.client.user.findUnique({
      where: { id: input.userId },
      select: { accountType: true },
    });
    let permission = input.permission;
    if (target?.accountType === 'CLIENT') {
      // A client-portal person has no workspace membership, so the rule is
      // "a live contact of a client in THIS workspace" instead, and client
      // people only ever read.
      const contact = await this.prisma.client.clientContact.findFirst({
        where: this.liveContactInWorkspace(input.userId, workspaceId),
        select: { id: true },
      });
      if (!contact) {
        throw new ForbiddenException({
          title: 'Not a client of this workspace',
          status: 403,
          detail: 'This person is not in the client portal of a client in this workspace.',
        });
      }
      permission = 'READ';
    } else {
      // Target must be an explicit workspace member - the workspace IS the
      // collaboration unit, so sharing with a non-member would grant access
      // to someone who can't otherwise read the workspace. They have to be
      // invited to the workspace first; then the document share applies.
      const member = await orgWorkspaceMembership(this.prisma, input.userId, workspaceId);
      if (!member) {
        throw new ForbiddenException({
          title: 'Not a workspace member',
          status: 403,
          detail: 'Cannot share with a user who is not a member of this workspace.',
        });
      }
    }
    return this.prisma.client.documentAccess.upsert({
      where: { documentId_userId: { documentId, userId: input.userId } },
      create: {
        documentId,
        userId: input.userId,
        permission,
        grantedById: ctx.userId,
      },
      update: { permission, grantedById: ctx.userId },
      include: {
        user: { select: ACCESS_USER_SELECT },
        grantedBy: { select: { id: true, name: true, email: true, image: true } },
      },
    });
  }

  async updateAccess(
    workspaceId: string,
    documentId: string,
    userId: string,
    input: UpdateDocumentAccessInput,
    ctx: DocumentAccessContext,
  ) {
    const { ownerId } = await this.ensureCanManageShare(workspaceId, documentId, ctx);
    if (userId === ownerId) {
      throw new ForbiddenException({
        title: 'Invalid grant',
        status: 403,
        detail: 'Cannot modify the owner record.',
      });
    }
    const existing = await this.prisma.client.documentAccess.findUnique({
      where: { documentId_userId: { documentId, userId } },
      select: { id: true, user: { select: { accountType: true } } },
    });
    if (!existing) {
      throw new NotFoundException({ title: 'Grant not found', status: 404 });
    }
    if (existing.user.accountType === 'CLIENT' && input.permission !== 'READ') {
      throw new BadRequestException({
        title: 'Clients can only read',
        status: 400,
        detail: 'People in the client portal get read-only access to documents.',
      });
    }
    return this.prisma.client.documentAccess.update({
      where: { documentId_userId: { documentId, userId } },
      data: { permission: input.permission },
      include: {
        user: { select: ACCESS_USER_SELECT },
        grantedBy: { select: { id: true, name: true, email: true, image: true } },
      },
    });
  }

  async removeAccess(
    workspaceId: string,
    documentId: string,
    userId: string,
    ctx: DocumentAccessContext,
  ) {
    const { ownerId } = await this.ensureCanManageShare(workspaceId, documentId, ctx);
    if (userId === ownerId) {
      throw new ForbiddenException({
        title: 'Invalid grant',
        status: 403,
        detail: 'Cannot remove the owner.',
      });
    }
    await this.prisma.client.documentAccess.deleteMany({
      where: { documentId, userId },
    });
  }

  // -------------------------------------------------------------------------
  // Client portal sharing - a whole client company, or its people one by one
  // -------------------------------------------------------------------------

  /** A live portal contact of a client in this workspace. */
  private liveContactInWorkspace(userId: string, workspaceId: string) {
    const live = livePortalContactWhere(userId);
    return { ...live, client: { ...live.client, workspaceId } };
  }

  /**
   * Clients this person may pick in the share dialog: the client of the
   * document's project and the client it is filed under, plus clients they
   * can see under the normal sales rules (every client with full access,
   * otherwise assigned ones) that already have portal people.
   */
  private async shareableClientWhere(
    workspaceId: string,
    documentId: string,
    actor: SalesActor,
  ): Promise<Record<string, unknown>> {
    const doc = await this.prisma.client.document.findFirst({
      where: { id: documentId, workspaceId },
      select: { clientId: true, project: { select: { clientId: true } } },
    });
    // The document's own clients: always offered, even with no portal people
    // yet, so the dialog can explain why there is nobody to share with.
    const ownClientIds = [doc?.project?.clientId, doc?.clientId].filter(
      (id): id is string => typeof id === 'string',
    );
    return {
      workspaceId,
      deletedAt: null,
      AND: [
        actor.fullClients
          ? {}
          : { OR: [{ assigneeId: actor.userId }, { id: { in: ownClientIds } }] },
        { OR: [{ contacts: { some: { deletedAt: null } } }, { id: { in: ownClientIds } }] },
      ],
    };
  }

  async listShareTargets(
    workspaceId: string,
    documentId: string,
    ctx: DocumentAccessContext,
    actor: SalesActor,
  ): Promise<DocumentShareTargets> {
    await this.ensureCanManageShare(workspaceId, documentId, ctx);
    const clients = await this.prisma.client.client.findMany({
      where: await this.shareableClientWhere(workspaceId, documentId, actor),
      orderBy: { name: 'asc' },
      take: 200,
      select: {
        id: true,
        name: true,
        documentShares: { where: { documentId }, select: { id: true } },
        contacts: {
          where: { deletedAt: null, user: { deletedAt: null, accountType: 'CLIENT' } },
          orderBy: { createdAt: 'asc' },
          select: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    const personIds = clients.flatMap((c) => c.contacts.map((k) => k.user.id));
    const grants = personIds.length
      ? await this.prisma.client.documentAccess.findMany({
          where: { documentId, userId: { in: personIds } },
          select: { userId: true },
        })
      : [];
    const granted = new Set(grants.map((g) => g.userId));
    return documentShareTargetsSchema.parse({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        companyShared: c.documentShares.length > 0,
        people: c.contacts.map((k) => ({
          userId: k.user.id,
          name: k.user.name,
          email: k.user.email,
          hasAccess: granted.has(k.user.id),
        })),
      })),
    });
  }

  /** Share with every portal person of a client, including future ones. */
  async addClientShare(
    workspaceId: string,
    documentId: string,
    input: AddDocumentClientShareInput,
    ctx: DocumentAccessContext,
    actor: SalesActor,
  ): Promise<DocumentClientShare> {
    await this.ensureCanManageShare(workspaceId, documentId, ctx);
    // The workspace is part of this where: a document is never shared with
    // another workspace's client.
    const client = await this.prisma.client.client.findFirst({
      where: {
        id: input.clientId,
        ...(await this.shareableClientWhere(workspaceId, documentId, actor)),
      },
      select: { id: true, workspace: { select: { organizationId: true } } },
    });
    if (!client) {
      throw new NotFoundException({ title: 'Client not found', status: 404 });
    }
    const share = await this.prisma.client.documentClientShare.upsert({
      where: { documentId_clientId: { documentId, clientId: client.id } },
      create: { documentId, clientId: client.id, grantedById: ctx.userId },
      update: {},
      select: CLIENT_SHARE_SELECT,
    });
    void this.auditLog.emit({
      organizationId: client.workspace.organizationId,
      actorUserId: ctx.userId,
      action: 'document.share.client',
      target: `document:${documentId}`,
      metadata: { clientId: client.id },
    });
    return documentClientShareSchema.parse(share);
  }

  async removeClientShare(
    workspaceId: string,
    documentId: string,
    clientId: string,
    ctx: DocumentAccessContext,
  ): Promise<void> {
    await this.ensureCanManageShare(workspaceId, documentId, ctx);
    await this.prisma.client.documentClientShare.deleteMany({ where: { documentId, clientId } });
  }
}

export type { DocumentAccessContext };
export type { DocumentPermission };
