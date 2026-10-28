import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AppAbility } from '@botss/auth';
import {
  createCustomFieldDefinitionSchema,
  type CreateCustomFieldDefinitionInput,
  cuid,
  listCustomFieldDefinitionsQuerySchema,
  type ListCustomFieldDefinitionsQuery,
  listCustomFieldValuesQuerySchema,
  type ListCustomFieldValuesQuery,
  setCustomFieldValueSchema,
  type SetCustomFieldValueInput,
  updateCustomFieldDefinitionSchema,
  type UpdateCustomFieldDefinitionInput,
} from '@botss/shared-types';

import { RequestAbility } from '../common/decorators/request-ability.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CustomFieldsService } from './custom-fields.service';

@Controller()
export class CustomFieldsController {
  constructor(private readonly customFields: CustomFieldsService) {}

  // Definitions ---------------------------------------------------------------

  @Get('custom-field-definitions')
  @RequireAbility('read', 'Workspace')
  listDefinitions(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listCustomFieldDefinitionsQuerySchema))
    query: ListCustomFieldDefinitionsQuery,
  ) {
    return this.customFields.listDefinitions(scope, query);
  }

  @Post('custom-field-definitions')
  @RequireAbility('manage', 'Workspace')
  createDefinition(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createCustomFieldDefinitionSchema))
    input: CreateCustomFieldDefinitionInput,
  ) {
    return this.customFields.createDefinition(scope, input);
  }

  @Patch('custom-field-definitions/:id')
  @RequireAbility('manage', 'Workspace')
  updateDefinition(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateCustomFieldDefinitionSchema))
    input: UpdateCustomFieldDefinitionInput,
  ) {
    return this.customFields.updateDefinition(scope, id, input);
  }

  @Delete('custom-field-definitions/:id')
  @RequireAbility('manage', 'Workspace')
  async deleteDefinition(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.customFields.deleteDefinition(scope, id);
    return { ok: true };
  }

  // Values --------------------------------------------------------------------

  @Get('custom-field-values')
  @RequireAbility('read', 'Workspace')
  listValues(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listCustomFieldValuesQuerySchema))
    query: ListCustomFieldValuesQuery,
  ) {
    if (query.projectId) return this.customFields.listTaskValuesForProject(scope, query.projectId);
    // The schema's refine guarantees entityId when projectId is absent.
    return this.customFields.listValues(scope, query.entityId as string);
  }

  // Set / clear: the guard only needs workspace read because a value can sit
  // on a project or a task; the service re-checks `update` on that row.
  @Post('custom-field-values')
  @RequireAbility('read', 'Workspace')
  setValue(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Body(new ZodValidationPipe(setCustomFieldValueSchema)) input: SetCustomFieldValueInput,
  ) {
    return this.customFields.setValue(scope, ability, input);
  }

  @Delete('custom-field-values/:id')
  @RequireAbility('read', 'Workspace')
  async clearValue(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.customFields.clearValue(scope, ability, id);
    return { ok: true };
  }
}
