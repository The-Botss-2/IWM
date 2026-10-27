import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  type ClientActivityList,
  type ClientHubPageQuery,
  clientHubPageQuerySchema,
  cuid,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ClientActivityService } from './client-activity.service';

/** A client's Activity tab: a merged, cursor-paged feed (newest first). */
@Controller('clients/:clientId/activity')
export class ClientActivityController {
  constructor(private readonly activity: ClientActivityService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @RequestUserScope() scope: UserScope,
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Query(new ZodValidationPipe(clientHubPageQuerySchema)) query: ClientHubPageQuery,
  ): Promise<ClientActivityList> {
    return this.activity.list(scope, actor, clientId, query);
  }
}
