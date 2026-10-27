import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import {
  type ClientCustomFieldValueList,
  type ClientHubOk,
  clientHubOkSchema,
  cuid,
  type CustomFieldValue,
  setClientCustomFieldSchema,
  type SetClientCustomFieldInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CustomFieldsService } from './custom-fields.service';

/**
 * CLIENT-scoped custom field values on one client. Reading follows client
 * visibility (finance roles included); writing needs the right to change the
 * client itself.
 */
@Controller('clients/:clientId/custom-fields')
export class ClientCustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<ClientCustomFieldValueList> {
    return this.customFields.listClientValues(actor, clientId);
  }

  @Put(':definitionId')
  @RequireAbility('update', 'Client')
  set(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('definitionId', new ZodValidationPipe(cuid)) definitionId: string,
    @Body(new ZodValidationPipe(setClientCustomFieldSchema)) input: SetClientCustomFieldInput,
  ): Promise<CustomFieldValue> {
    return this.customFields.setClientValue(actor, clientId, definitionId, input);
  }

  @Delete(':definitionId')
  @RequireAbility('update', 'Client')
  async clear(
    @CurrentSalesActor() actor: SalesActor,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('definitionId', new ZodValidationPipe(cuid)) definitionId: string,
  ): Promise<ClientHubOk> {
    await this.customFields.clearClientValue(actor, clientId, definitionId);
    return clientHubOkSchema.parse({ ok: true });
  }
}
