import { Controller, Get } from '@nestjs/common';

import {
  CurrentSalesActor,
  type SalesActor,
} from '../common/decorators/sales-actor.decorator';
import { SalesAccessService } from './sales-access.service';

@Controller('sales-access')
export class SalesAccessController {
  constructor(private readonly salesAccess: SalesAccessService) {}

  /**
   * Deliberately carries no `@RequireAbility`: every authenticated user may ask
   * whether the sales surfaces apply to them. The answer is derived from their
   * own role and assignments, so it discloses nothing they can't already see.
   */
  @Get()
  get(@CurrentSalesActor() actor: SalesActor) {
    return this.salesAccess.forActor(actor);
  }
}
