import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  type CreateTodoInput,
  createTodoSchema,
  cuid,
  type ListTodosQuery,
  listTodosQuerySchema,
  type UpdateTodoInput,
  updateTodoSchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TodosService } from './todos.service';

@Controller('todos')
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Query(new ZodValidationPipe(listTodosQuerySchema)) query: ListTodosQuery,
  ) {
    return this.todos.list(user.id, workspaceId, query);
  }

  @Post()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(createTodoSchema)) input: CreateTodoInput,
  ) {
    return this.todos.create(user.id, workspaceId, input);
  }

  @Patch(':id')
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateTodoSchema)) input: UpdateTodoInput,
  ) {
    return this.todos.update(user.id, id, input);
  }

  @Delete(':id')
  @SkipPermissions()
  remove(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.todos.remove(user.id, id);
  }
}
