import { Controller, Get, Param } from '@nestjs/common';
import { cuid, type ClientDocumentList } from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ClientDocumentsService } from './client-documents.service';

/**
 * A client's Documents tab. `read Client` is the coarse gate; the service
 * applies client visibility and the normal document read rule.
 */
@Controller('clients/:clientId/documents')
export class ClientDocumentsController {
  constructor(private readonly clientDocuments: ClientDocumentsService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @RequestUserScope() scope: UserScope,
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<ClientDocumentList> {
    return this.clientDocuments.list(scope, actor, clientId);
  }
}
