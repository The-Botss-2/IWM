import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  cancelSignatureRequestSchema,
  type CancelSignatureRequestInput,
  createSignatureRequestSchema,
  type CreateSignatureRequestInput,
  cuid,
  listSignatureRequestsQuerySchema,
  type ListSignatureRequestsQuery,
  sendSignatureRequestSchema,
  type SendSignatureRequestInput,
  setSignatureFieldsSchema,
  type SetSignatureFieldsInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { sendPdf } from './send-pdf';
import { type SignatureActor, SignaturesService } from './signatures.service';

function actorOf(
  req: Request & RequestExtensions,
  workspaceId: string,
  userId: string,
): SignatureActor {
  const role = (req.workspaceMemberships ?? []).find((m) => m.workspaceId === workspaceId)?.role;
  return { userId, workspaceId, workspaceRole: role };
}

/** E-signature requests, for workspace members. Signers use the public controller. */
@Controller('signatures')
export class SignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get()
  @RequireAbility('read', 'SignatureRequest')
  list(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Query(new ZodValidationPipe(listSignatureRequestsQuerySchema)) q: ListSignatureRequestsQuery,
  ) {
    return this.signatures.list(actorOf(req, workspaceId, user.id), q);
  }

  @Post()
  @RequireAbility('create', 'SignatureRequest')
  create(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Body(new ZodValidationPipe(createSignatureRequestSchema)) input: CreateSignatureRequestInput,
  ) {
    return this.signatures.create(actorOf(req, workspaceId, user.id), input);
  }

  @Get(':id')
  @RequireAbility('read', 'SignatureRequest')
  get(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.signatures.get(actorOf(req, workspaceId, user.id), id);
  }

  @Put(':id/fields')
  @RequireAbility('update', 'SignatureRequest')
  setFields(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(setSignatureFieldsSchema)) input: SetSignatureFieldsInput,
  ) {
    return this.signatures.setFields(actorOf(req, workspaceId, user.id), id, input);
  }

  @Post(':id/send')
  @RequireAbility('update', 'SignatureRequest')
  send(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(sendSignatureRequestSchema)) input: SendSignatureRequestInput,
  ) {
    return this.signatures.send(actorOf(req, workspaceId, user.id), id, input);
  }

  @Post(':id/signers/:signerId/resend')
  @RequireAbility('update', 'SignatureRequest')
  resend(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
  ) {
    return this.signatures.resend(actorOf(req, workspaceId, user.id), id, signerId);
  }

  @Post(':id/cancel')
  @RequireAbility('update', 'SignatureRequest')
  cancel(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(cancelSignatureRequestSchema)) input: CancelSignatureRequestInput,
  ) {
    return this.signatures.cancel(actorOf(req, workspaceId, user.id), id, input);
  }

  @Post(':id/seal')
  @RequireAbility('update', 'SignatureRequest')
  retrySeal(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.signatures.retrySeal(actorOf(req, workspaceId, user.id), id);
  }

  @Delete(':id')
  @RequireAbility('update', 'SignatureRequest')
  removeDraft(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.signatures.removeDraft(actorOf(req, workspaceId, user.id), id);
  }

  @Get(':id/file')
  @RequireAbility('read', 'SignatureRequest')
  async sourceFile(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(
      res,
      await this.signatures.sourceFile(actorOf(req, workspaceId, user.id), id),
      'inline',
    );
  }

  @Get(':id/signed-file')
  @RequireAbility('read', 'SignatureRequest')
  async signedFile(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(
      res,
      await this.signatures.signedFile(actorOf(req, workspaceId, user.id), id),
      'attachment',
    );
  }
}
