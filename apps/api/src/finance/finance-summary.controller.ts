import { Controller, Get, Query } from '@nestjs/common';
import {
  financeSummaryQuerySchema,
  type FinanceSummaryQuery,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { FinanceSummaryService } from './finance-summary.service';

@Controller('finance/summary')
export class FinanceSummaryController {
  constructor(private readonly summary: FinanceSummaryService) {}

  @Get()
  @RequireAbility('read', 'Contract')
  get(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(financeSummaryQuerySchema)) q: FinanceSummaryQuery,
  ) {
    return this.summary.summary(scope, q);
  }
}
