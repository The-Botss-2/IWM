import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createGoalSchema,
  type CreateGoalInput,
  createGoalUpdateSchema,
  type CreateGoalUpdateInput,
  createKeyResultSchema,
  type CreateKeyResultInput,
  cuid,
  updateGoalSchema,
  type UpdateGoalInput,
  updateKeyResultSchema,
  type UpdateKeyResultInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { GoalsService } from './goals.service';

@Controller()
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get('projects/:projectId/goals')
  @RequireAbility('read', 'Project')
  list(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.goals.list(scope, projectId);
  }

  @Post('projects/:projectId/goals')
  @RequireAbility('update', 'Project')
  create(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Body(new ZodValidationPipe(createGoalSchema)) input: CreateGoalInput,
  ) {
    return this.goals.create(scope, projectId, input);
  }

  @Patch('goals/:id')
  @RequireAbility('update', 'Project')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateGoalSchema)) input: UpdateGoalInput,
  ) {
    return this.goals.update(scope, id, input);
  }

  @Delete('goals/:id')
  @RequireAbility('update', 'Project')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.goals.remove(scope, id);
    return { ok: true };
  }

  @Get('goals/:id/key-results')
  @RequireAbility('read', 'Project')
  listKrs(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.goals.listKeyResults(scope, id);
  }

  @Post('goals/:id/key-results')
  @RequireAbility('update', 'Project')
  createKr(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(createKeyResultSchema)) input: CreateKeyResultInput,
  ) {
    return this.goals.createKeyResult(scope, id, input);
  }

  @Patch('key-results/:id')
  @RequireAbility('update', 'Project')
  updateKr(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateKeyResultSchema)) input: UpdateKeyResultInput,
  ) {
    return this.goals.updateKeyResult(scope, id, input);
  }

  @Delete('key-results/:id')
  @RequireAbility('update', 'Project')
  async removeKr(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.goals.removeKeyResult(scope, id);
    return { ok: true };
  }

  @Get('goals/:id/updates')
  @RequireAbility('read', 'Project')
  listUpdates(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.goals.listUpdates(scope, id);
  }

  @Post('goals/:id/updates')
  @RequireAbility('update', 'Project')
  createUpdate(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(createGoalUpdateSchema)) input: CreateGoalUpdateInput,
  ) {
    return this.goals.createUpdate(scope, user.id, id, input);
  }
}
