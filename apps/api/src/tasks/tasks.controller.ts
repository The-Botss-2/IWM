import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  bulkTaskRequestSchema,
  type BulkTaskRequest,
  createTaskSchema,
  type CreateTaskInput,
  cuid,
  listTasksQuerySchema,
  type ListTasksQuery,
  reorderTaskSchema,
  type ReorderTaskInput,
  updateTaskSchema,
  type UpdateTaskInput,
} from '@botss/shared-types';

import type { AppAbility } from '@botss/auth';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequestAbility } from '../common/decorators/request-ability.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequireAbility('read', 'Task')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listTasksQuerySchema)) q: ListTasksQuery,
  ) {
    return this.tasks.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Task')
  create(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createTaskSchema)) input: CreateTaskInput,
  ) {
    return this.tasks.create(scope, user.id, input);
  }

  @Post('bulk')
  @RequireAbility('update', 'Task')
  bulk(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Body(new ZodValidationPipe(bulkTaskRequestSchema)) input: BulkTaskRequest,
  ) {
    return this.tasks.bulk(scope, ability, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Task')
  get(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.tasks.get(scope, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Task')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateTaskSchema)) input: UpdateTaskInput,
  ) {
    return this.tasks.update(scope, id, input);
  }

  @Patch(':id/reorder')
  @RequireAbility('update', 'Task')
  reorder(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(reorderTaskSchema)) input: ReorderTaskInput,
  ) {
    return this.tasks.reorder(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Task')
  async remove(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.tasks.remove(scope, ability, id);
    return { ok: true };
  }

  @Post(':id/archive')
  @RequireAbility('delete', 'Task')
  archive(
    @RequestUserScope() scope: UserScope,
    @RequestAbility() ability: AppAbility,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.tasks.archive(scope, ability, id);
  }

  @Post(':id/restore')
  @RequireAbility('update', 'Task')
  restore(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.tasks.restore(scope, id);
  }
}
