import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateLeaveInput,
  createLeaveSchema,
  cuid,
  type ListLeavesQuery,
  listLeavesQuerySchema,
  type UpdateLeaveStatusInput,
  updateLeaveStatusSchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { LeavesService } from './leaves.service';

/**
 * Leave requests. Self-scoped for EMPLOYEE callers (Zod-validated and
 * server-side enforced in the service), wide-open for ADMIN / HR.
 *
 * Endpoints intentionally don't carry a workspace prefix - leave belongs
 * to the user, not a workspace.
 */
@Controller('leaves')
export class LeavesController {
  constructor(private readonly leaves: LeavesService) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listLeavesQuerySchema)) query: ListLeavesQuery,
  ) {
    return this.leaves.list(user.id, query);
  }

  @Post()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createLeaveSchema)) input: CreateLeaveInput,
  ) {
    return this.leaves.create(user.id, input);
  }

  @Patch(':id/status')
  @SkipPermissions()
  updateStatus(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateLeaveStatusSchema))
    input: UpdateLeaveStatusInput,
  ) {
    return this.leaves.updateStatus(user.id, id, input);
  }

  @Delete(':id')
  @SkipPermissions()
  remove(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.leaves.remove(user.id, id);
  }
}
