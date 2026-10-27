import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  createMilestoneSchema,
  type CreateMilestoneInput,
  cuid,
  linkMilestoneWorkSchema,
  type LinkMilestoneWorkInput,
  reorderMilestonesSchema,
  type ReorderMilestonesInput,
  updateMilestoneSchema,
  type UpdateMilestoneInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { MilestonesService } from './milestones.service';

/**
 * Milestones are part of their contract rather than a resource in their own
 * right, so every route is gated on `update Contract` - being allowed to edit
 * a contract is being allowed to edit its stages.
 */
@Controller('finance')
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  /** Delivered work that has not been fully paid for. */
  @Get('awaiting-payment')
  @RequireAbility('read', 'Contract')
  awaitingPayment(@RequestUserScope() scope: UserScope) {
    return this.milestones.awaitingPayment(scope);
  }

  @Post('contracts/:contractId/milestones')
  @RequireAbility('update', 'Contract')
  create(
    @RequestUserScope() scope: UserScope,
    @Param('contractId', new ZodValidationPipe(cuid)) contractId: string,
    @Body(new ZodValidationPipe(createMilestoneSchema)) input: CreateMilestoneInput,
  ) {
    return this.milestones.create(scope, contractId, input);
  }

  @Patch('contracts/:contractId/milestones/reorder')
  @RequireAbility('update', 'Contract')
  reorder(
    @RequestUserScope() scope: UserScope,
    @Param('contractId', new ZodValidationPipe(cuid)) contractId: string,
    @Body(new ZodValidationPipe(reorderMilestonesSchema)) input: ReorderMilestonesInput,
  ) {
    return this.milestones.reorder(scope, contractId, input);
  }

  @Patch('milestones/:id')
  @RequireAbility('update', 'Contract')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateMilestoneSchema)) input: UpdateMilestoneInput,
  ) {
    return this.milestones.update(scope, id, input);
  }

  /** Set the sprint / tasks this milestone bills. Replaces, does not merge. */
  @Put('milestones/:id/work')
  @RequireAbility('update', 'Contract')
  linkWork(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(linkMilestoneWorkSchema)) input: LinkMilestoneWorkInput,
  ) {
    return this.milestones.linkWork(scope, id, input);
  }

  @Post('milestones/:id/deliver')
  @RequireAbility('update', 'Contract')
  deliver(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.milestones.deliver(scope, id);
  }

  @Delete('milestones/:id')
  @RequireAbility('update', 'Contract')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.milestones.remove(scope, id);
    return { ok: true };
  }
}
