import { Body, Controller, Get, Headers, Ip, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  ACCESS_CODE_HEADER,
  accessCode,
  declinePublicSchema,
  type DeclinePublicInput,
  signingToken,
  signPublicSchema,
  type SignPublicInput,
} from '@botss/shared-types';

import { Public } from '../common/decorators/public.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { sendPdf } from './send-pdf';
import { SignaturesService } from './signatures.service';

/** The typed code; a malformed one is a 400 and does not burn an attempt.
 *  (`@Headers()` takes no pipe, so the pipe is applied by hand.) */
const codePipe = new ZodValidationPipe(accessCode.optional());
function parseCode(raw: string | undefined): string | undefined {
  return codePipe.transform(raw);
}

/**
 * Login-free signing surface. Two factors on every route: the token in the
 * path (hashed and matched against `SignatureSigner.tokenHash`) and the
 * 6-digit code from the email in the `x-access-code` header (checked against
 * `codeHash`, with a lockout). Mounted under `/public/*` next to public
 * documents, rate-limited at the Express layer (main.ts) and again per IP for
 * sign and decline in the service.
 */
@Public()
@SkipPermissions()
@Controller('public/signatures')
export class PublicSignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get(':token')
  session(
    @Param('token', new ZodValidationPipe(signingToken)) token: string,
    @Headers(ACCESS_CODE_HEADER) rawCode: string | undefined,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.signatures.session(token, parseCode(rawCode), {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Get(':token/file')
  async file(
    @Param('token', new ZodValidationPipe(signingToken)) token: string,
    @Headers(ACCESS_CODE_HEADER) rawCode: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.signatures.publicSourceFile(token, parseCode(rawCode)), 'inline');
  }

  @Get(':token/signed-file')
  async signedFile(
    @Param('token', new ZodValidationPipe(signingToken)) token: string,
    @Headers(ACCESS_CODE_HEADER) rawCode: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.signatures.publicSignedFile(token, parseCode(rawCode)), 'attachment');
  }

  @Post(':token/sign')
  sign(
    @Param('token', new ZodValidationPipe(signingToken)) token: string,
    @Headers(ACCESS_CODE_HEADER) rawCode: string | undefined,
    @Body(new ZodValidationPipe(signPublicSchema)) input: SignPublicInput,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.signatures.sign(token, parseCode(rawCode), input, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post(':token/decline')
  decline(
    @Param('token', new ZodValidationPipe(signingToken)) token: string,
    @Headers(ACCESS_CODE_HEADER) rawCode: string | undefined,
    @Body(new ZodValidationPipe(declinePublicSchema)) input: DeclinePublicInput,
    @Ip() ip: string | undefined,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.signatures.decline(token, parseCode(rawCode), input, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
