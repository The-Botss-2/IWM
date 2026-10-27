import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  type ClientHubPageQuery,
  clientHubPageQuerySchema,
  type ClientSignatureList,
  cuid,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SignaturesService } from './signatures.service';

/**
 * A client's Signatures tab. Downloads, resend and cancel reuse the existing
 * `/signatures/:id/*` routes, which re-check access per request.
 */
@Controller('clients/:clientId/signatures')
export class ClientSignaturesController {
  constructor(private readonly signatures: SignaturesService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @CurrentWorkspaceId() workspaceId: string,
    @CurrentUser() user: AuthedUser,
    @CurrentSalesActor() clientViewer: SalesActor,
    @Req() req: Request & RequestExtensions,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Query(new ZodValidationPipe(clientHubPageQuerySchema)) query: ClientHubPageQuery,
  ): Promise<ClientSignatureList> {
    const role = (req.workspaceMemberships ?? []).find((m) => m.workspaceId === workspaceId)?.role;
    return this.signatures.listForClient(
      { userId: user.id, workspaceId, workspaceRole: role },
      clientViewer,
      clientId,
      query,
    );
  }
}
