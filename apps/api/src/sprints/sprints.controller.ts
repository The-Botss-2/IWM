import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  createSprintSchema,
  type CreateSprintInput,
  cuid,
  moveSprintTaskSchema,
  type MoveSprintTaskInput,
  reorderSprintTaskSchema,
  type ReorderSprintTaskInput,
  updateSprintSchema,
  type UpdateSprintInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SprintsService } from './sprints.service';

const addTaskSchema = z.object({ taskId: cuid });

@Controller()
export class SprintsController {
  constructor(private readonly sprints: SprintsService) {}

  @Get('projects/:projectId/sprints')
  @RequireAbility('read', 'Project')
  list(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ) {
    return this.sprints.list(scope, projectId);
  }

  @Post('projects/:projectId/sprints')
  @RequireAbility('update', 'Project')
  create(
    @RequestUserScope() scope: UserScope,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
    @Body(new ZodValidationPipe(createSprintSchema)) input: CreateSprintInput,
  ) {
    return this.sprints.create(scope, projectId, input);
  }

  @Patch('sprints/:id')
  @RequireAbility('update', 'Project')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateSprintSchema)) input: UpdateSprintInput,
  ) {
    return this.sprints.update(scope, id, input);
  }

  @Delete('sprints/:id')
  @RequireAbility('update', 'Project')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.sprints.remove(scope, id);
    return { ok: true };
  }

  @Post('sprints/:id/start')
  @RequireAbility('update', 'Project')
  start(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.sprints.start(scope, id);
  }

  @Post('sprints/:id/complete')
  @RequireAbility('update', 'Project')
  complete(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.sprints.complete(scope, id);
  }

  @Post('sprints/:id/tasks')
  @RequireAbility('update', 'Project')
  async addTask(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(addTaskSchema)) input: { taskId: string },
  ) {
    await this.sprints.addTask(scope, user.id, id, input.taskId);
    return { ok: true };
  }

  @Delete('sprints/:id/tasks/:taskId')
  @RequireAbility('update', 'Project')
  async removeTask(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Param('taskId', new ZodValidationPipe(cuid)) taskId: string,
  ) {
    await this.sprints.removeTask(scope, id, taskId);
    return { ok: true };
  }

  @Patch('sprints/:id/reorder')
  @RequireAbility('update', 'Project')
  async reorderTask(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(reorderSprintTaskSchema)) input: ReorderSprintTaskInput,
  ) {
    await this.sprints.reorderTask(scope, id, input);
    return { ok: true };
  }

  @Post('sprints/move-task')
  @RequireAbility('update', 'Project')
  async moveTask(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(moveSprintTaskSchema)) input: MoveSprintTaskInput,
  ) {
    await this.sprints.moveTask(scope, input);
    return { ok: true };
  }
}
