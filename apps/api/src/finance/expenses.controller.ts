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
  createExpenseSchema,
  type CreateExpenseInput,
  cuid,
  listExpensesQuerySchema,
  type ListExpensesQuery,
  updateExpenseSchema,
  type UpdateExpenseInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ExpensesService } from './expenses.service';

@Controller('finance/expenses')
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get()
  @RequireAbility('read', 'Expense')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listExpensesQuerySchema)) q: ListExpensesQuery,
  ) {
    return this.expenses.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Expense')
  create(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createExpenseSchema)) input: CreateExpenseInput,
  ) {
    return this.expenses.create(scope, input);
  }

  @Patch(':id')
  @RequireAbility('update', 'Expense')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateExpenseSchema)) input: UpdateExpenseInput,
  ) {
    return this.expenses.update(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Expense')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.expenses.remove(scope, id);
    return { ok: true };
  }
}
