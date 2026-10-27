import { Body, Controller, Get, HttpCode, Headers, Ip, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  cuid,
  declinePublicSchema,
  signPublicSchema,
  type DeclinePublicInput,
  type PortalOk,
  type PortalSignatureList,
  type PublicSignatureSession,
  type SignPublicInput,
  type SignPublicResponse,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { sendPdf } from '../signatures/send-pdf';
import { PortalSignaturesService } from './portal-signatures.service';

@PortalRoute()
@Controller('portal/clients/:clientId/signatures')
export class PortalSignaturesController {
  constructor(private readonly signatures: PortalSignaturesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalSignatureList> {
    return this.signatures.list(user, clientId);
  }

  @Get(':signerId')
  session(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<PublicSignatureSession> {
    return this.signatures.session(user, clientId, signerId, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Get(':signerId/file')
  async file(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.signatures.sourceFile(user, clientId, signerId), 'inline');
  }

  @Get(':signerId/signed-file')
  async signedFile(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.signatures.signedFile(user, clientId, signerId), 'attachment');
  }

  @Post(':signerId/sign')
  @HttpCode(200)
  sign(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
    @Body(new ZodValidationPipe(signPublicSchema)) input: SignPublicInput,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<SignPublicResponse> {
    return this.signatures.sign(user, clientId, signerId, input, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post(':signerId/decline')
  @HttpCode(200)
  decline(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('signerId', new ZodValidationPipe(cuid)) signerId: string,
    @Body(new ZodValidationPipe(declinePublicSchema)) input: DeclinePublicInput,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<PortalOk> {
    return this.signatures.decline(user, clientId, signerId, input, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
