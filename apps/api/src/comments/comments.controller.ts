import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  type CreateCommentInput,
  createCommentSchema,
  cuid,
  type ListCommentsQuery,
  listCommentsQuerySchema,
  type UpdateCommentInput,
  updateCommentSchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CommentsService } from './comments.service';

@Controller()
export class CommentsController {
  constructor(private readonly comments: CommentsService) {}

  @Get('tasks/:taskId/comments')
  @RequireAbility('read', 'Task')
  list(
    @RequestUserScope() scope: UserScope,
    @Param('taskId', new ZodValidationPipe(cuid)) taskId: string,
    @Query(new ZodValidationPipe(listCommentsQuerySchema)) q: ListCommentsQuery,
  ) {
    return this.comments.list(scope, taskId, q);
  }

  @Post('tasks/:taskId/comments')
  @RequireAbility('update', 'Task')
  create(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('taskId', new ZodValidationPipe(cuid)) taskId: string,
    @Body(new ZodValidationPipe(createCommentSchema)) input: CreateCommentInput,
  ) {
    return this.comments.create(scope, user.id, taskId, input);
  }

  @Patch('comments/:id')
  @RequireAbility('update', 'Task')
  update(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateCommentSchema)) input: UpdateCommentInput,
  ) {
    return this.comments.update(scope, user.id, id, input);
  }

  @Delete('comments/:id')
  @RequireAbility('update', 'Task')
  async remove(
    @RequestUserScope() scope: UserScope,
    @CurrentUser() user: AuthedUser,
    @Req() req: Request & RequestExtensions,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.comments.remove(scope, user.id, req.workspaceMemberships ?? [], id);
    return { ok: true };
  }
}
