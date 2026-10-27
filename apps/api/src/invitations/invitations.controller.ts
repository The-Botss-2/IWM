import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  acceptInvitationResponseSchema,
  acceptInvitationSchema,
  invitationInfoSchema,
  invitationPreviewSchema,
  invitationToken,
  verifyInvitationSchema,
  type AcceptInvitationInput,
  type AcceptInvitationResponse,
  type InvitationInfo,
  type InvitationPreview,
} from '@botss/shared-types';
import type { z } from 'zod';

import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { InvitationsService } from './invitations.service';

/**
 * Public, rate-limited in main.ts. GET reveals only the link's kind; the
 * invitee's email and workspace come from POST /verify once the 6-digit code
 * from the email checks out (workspace invites), and POST /accept checks the
 * code again.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get(':token')
  @Public()
  async preview(
    @Param('token', new ZodValidationPipe(invitationToken)) token: string,
  ): Promise<InvitationPreview> {
    return invitationPreviewSchema.parse(await this.invitations.preview(token));
  }

  @Post(':token/verify')
  @Public()
  @HttpCode(200)
  async verify(
    @Param('token', new ZodValidationPipe(invitationToken)) token: string,
    @Body(new ZodValidationPipe(verifyInvitationSchema))
    input: z.output<typeof verifyInvitationSchema>,
  ): Promise<InvitationInfo> {
    return invitationInfoSchema.parse(await this.invitations.verify(token, input.code));
  }

  @Post(':token/accept')
  @Public()
  async accept(
    @Param('token', new ZodValidationPipe(invitationToken)) token: string,
    @Body(new ZodValidationPipe(acceptInvitationSchema)) input: AcceptInvitationInput,
  ): Promise<AcceptInvitationResponse> {
    return acceptInvitationResponseSchema.parse(await this.invitations.accept(token, input));
  }
}
