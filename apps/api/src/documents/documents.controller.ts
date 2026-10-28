import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  addDocumentAccessSchema,
  addDocumentClientShareSchema,
  type AddDocumentAccessInput,
  type AddDocumentClientShareInput,
  type DocumentClientShare,
  type DocumentShareTargets,
  portalOkSchema,
  type PortalOk,
  createDocumentSchema,
  type CreateDocumentInput,
  cuid,
  listDocumentsQuerySchema,
  type ListDocumentsQuery,
  sharePublicLinkSchema,
  type SharePublicLinkInput,
  updateDocumentAccessSchema,
  type UpdateDocumentAccessInput,
  updateDocumentSchema,
  type UpdateDocumentInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { DocumentsService, type DocumentAccessContext } from './documents.service';

/** Pulls the per-request access context out of the AuthGuard's payload. The
 *  document service uses this to gate reads, edits, and share-management. */
function ctxOf(
  req: Request & RequestExtensions,
  workspaceId: string,
  userId: string,
): DocumentAccessContext {
  const role = (req.workspaceMemberships ?? []).find((m) => m.workspaceId === workspaceId)?.role;
  return { userId, workspaceRole: role };
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @RequireAbility('read', 'Document')
  list(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) q: ListDocumentsQuery,
  ) {
    return this.documents.list(workspaceId, q, ctxOf(req, workspaceId, user.id));
  }

  @Post()
  @RequireAbility('create', 'Document')
  create(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createDocumentSchema)) input: CreateDocumentInput,
  ) {
    return this.documents.create(workspaceId, user.id, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Document')
  get(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.documents.get(workspaceId, id, ctxOf(req, workspaceId, user.id));
  }

  @Patch(':id')
  @RequireAbility('update', 'Document')
  update(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) input: UpdateDocumentInput,
  ) {
    return this.documents.update(workspaceId, id, input, ctxOf(req, workspaceId, user.id));
  }

  @Post(':id/share')
  @RequireAbility('update', 'Document')
  share(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(sharePublicLinkSchema)) input: SharePublicLinkInput,
  ) {
    return this.documents.sharePublic(
      workspaceId,
      id,
      input.publicReadOnly,
      ctxOf(req, workspaceId, user.id),
      input.expiresAt ?? null,
    );
  }

  @Delete(':id/share')
  @RequireAbility('update', 'Document')
  unshare(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.documents.unshare(workspaceId, id, ctxOf(req, workspaceId, user.id));
  }

  // ---------------------------------------------------------------------------
  // Internal sharing - explicit DocumentAccess grants
  // ---------------------------------------------------------------------------

  @Get(':id/access')
  @RequireAbility('read', 'Document')
  listAccess(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.documents.listAccess(workspaceId, id, ctxOf(req, workspaceId, user.id));
  }

  @Post(':id/access')
  @RequireAbility('update', 'Document')
  addAccess(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(addDocumentAccessSchema)) input: AddDocumentAccessInput,
  ) {
    return this.documents.addAccess(workspaceId, id, input, ctxOf(req, workspaceId, user.id));
  }

  @Patch(':id/access/:userId')
  @RequireAbility('update', 'Document')
  updateAccess(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('userId', new ZodValidationPipe(cuid)) targetUserId: string,
    @Body(new ZodValidationPipe(updateDocumentAccessSchema)) input: UpdateDocumentAccessInput,
  ) {
    return this.documents.updateAccess(
      workspaceId,
      id,
      targetUserId,
      input,
      ctxOf(req, workspaceId, user.id),
    );
  }

  // ---------------------------------------------------------------------------
  // Client portal sharing - a whole client company, or its people one by one
  // (people go through the access routes above, as READ-only grants)
  // ---------------------------------------------------------------------------

  @Get(':id/share-targets')
  @RequireAbility('update', 'Document')
  shareTargets(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @CurrentSalesActor() actor: SalesActor,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ): Promise<DocumentShareTargets> {
    return this.documents.listShareTargets(
      workspaceId,
      id,
      ctxOf(req, workspaceId, user.id),
      actor,
    );
  }

  @Post(':id/client-shares')
  @RequireAbility('update', 'Document')
  addClientShare(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @CurrentSalesActor() actor: SalesActor,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(addDocumentClientShareSchema)) input: AddDocumentClientShareInput,
  ): Promise<DocumentClientShare> {
    return this.documents.addClientShare(
      workspaceId,
      id,
      input,
      ctxOf(req, workspaceId, user.id),
      actor,
    );
  }

  @Delete(':id/client-shares/:clientId')
  @RequireAbility('update', 'Document')
  async removeClientShare(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalOk> {
    await this.documents.removeClientShare(
      workspaceId,
      id,
      clientId,
      ctxOf(req, workspaceId, user.id),
    );
    return portalOkSchema.parse({ ok: true });
  }

  @Delete(':id/access/:userId')
  @RequireAbility('update', 'Document')
  async removeAccess(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('userId', new ZodValidationPipe(cuid)) targetUserId: string,
  ) {
    await this.documents.removeAccess(
      workspaceId,
      id,
      targetUserId,
      ctxOf(req, workspaceId, user.id),
    );
    return { ok: true };
  }

  @Delete(':id')
  @RequireAbility('delete', 'Document')
  async remove(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.documents.remove(workspaceId, id, ctxOf(req, workspaceId, user.id));
    return { ok: true };
  }
}
