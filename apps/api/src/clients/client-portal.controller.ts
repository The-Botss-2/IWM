import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  cuid,
  inviteClientContactSchema,
  portalOkSchema,
  updateClientContactSchema,
  type ClientContact,
  type ClientContactLinkResponse,
  type ClientContactList,
  type InviteClientContactInput,
  type PortalOk,
  type UpdateClientContactInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ClientPortalService } from './client-portal.service';

/**
 * Who at a client may use the client portal. `@RequireAbility` is the coarse
 * gate; the service enforces the real one (client visibility to list,
 * workspace owner/admin or org admin to change anything).
 */
@Controller('clients/:clientId/portal-contacts')
export class ClientPortalController {
  constructor(private readonly portal: ClientPortalService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<ClientContactList> {
    return this.portal.list(actor, clientId);
  }

  @Post()
  @RequireAbility('update', 'Client')
  invite(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Body(new ZodValidationPipe(inviteClientContactSchema)) input: InviteClientContactInput,
  ): Promise<ClientContactLinkResponse> {
    return this.portal.invite(actor, clientId, input);
  }

  @Post(':contactId/resend')
  @HttpCode(200)
  @RequireAbility('update', 'Client')
  resend(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('contactId', new ZodValidationPipe(cuid)) contactId: string,
  ): Promise<ClientContactLinkResponse> {
    return this.portal.resend(actor, clientId, contactId);
  }

  @Post(':contactId/password-reset')
  @HttpCode(200)
  @RequireAbility('update', 'Client')
  sendPasswordReset(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('contactId', new ZodValidationPipe(cuid)) contactId: string,
  ): Promise<ClientContactLinkResponse> {
    return this.portal.sendPasswordReset(actor, clientId, contactId);
  }

  @Patch(':contactId')
  @RequireAbility('update', 'Client')
  updateRole(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('contactId', new ZodValidationPipe(cuid)) contactId: string,
    @Body(new ZodValidationPipe(updateClientContactSchema)) input: UpdateClientContactInput,
  ): Promise<ClientContact> {
    return this.portal.updateRole(actor, clientId, contactId, input);
  }

  @Delete(':contactId')
  @RequireAbility('update', 'Client')
  async revoke(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('contactId', new ZodValidationPipe(cuid)) contactId: string,
  ): Promise<PortalOk> {
    await this.portal.revoke(actor, clientId, contactId);
    return portalOkSchema.parse({ ok: true });
  }
}
