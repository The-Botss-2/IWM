import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createSavedViewSchema,
  type CreateSavedViewInput,
  cuid,
  updateSavedViewSchema,
  type UpdateSavedViewInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SavedViewsService } from './saved-views.service';

@Controller()
export class SavedViewsController {
  constructor(private readonly views: SavedViewsService) {}

  @Get('projects/:projectId/saved-views')
  @RequireAbility('read', 'Project')
  list(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.views.list(scope, projectId, user.id);
  }

  @Post('projects/:projectId/saved-views')
  @RequireAbility('read', 'Project')
  create(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Body(new ZodValidationPipe(createSavedViewSchema)) input: CreateSavedViewInput,
  ) {
    return this.views.create(scope, user.id, projectId, input);
  }

  @Patch('saved-views/:id')
  @RequireAbility('read', 'Project')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateSavedViewSchema)) input: UpdateSavedViewInput,
  ) {
    return this.views.update(scope, id, input);
  }

  @Delete('saved-views/:id')
  @RequireAbility('read', 'Project')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.views.remove(scope, id);
    return { ok: true };
  }
}
