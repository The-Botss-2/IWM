import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import {
  cuid,
  listUsersQuerySchema,
  type ListUsersQuery,
  updateUserSchema,
  type UpdateUserInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @CurrentWorkspaceId() workspaceId: string,
    @Query(new ZodValidationPipe(listUsersQuerySchema)) query: ListUsersQuery,
  ) {
    return this.users.listInWorkspace(workspaceId, query);
  }

  @Get('me')
  me(@CurrentUser() user: AuthedUser) {
    return this.users.getById(user.id);
  }

  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(updateUserSchema)) input: UpdateUserInput,
  ) {
    return this.users.updateMe(user.id, input);
  }

  @Get(':id')
  get(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.users.getByIdScoped(scope, id);
  }
}
