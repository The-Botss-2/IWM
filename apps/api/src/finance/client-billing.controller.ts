import { Controller, Get, Param } from '@nestjs/common';
import { type ClientBillingSummary, cuid } from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ClientBillingService } from './client-billing.service';

/** Billing summary for one client. Finance roles only (checked twice). */
@Controller('clients/:clientId/billing-summary')
export class ClientBillingController {
  constructor(private readonly billing: ClientBillingService) {}

  @Get()
  @RequireAbility('read', 'Invoice')
  get(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<ClientBillingSummary> {
    return this.billing.summary(actor, clientId);
  }
}
