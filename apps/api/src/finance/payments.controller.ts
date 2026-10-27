import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createPaymentSchema,
  type CreatePaymentInput,
  cuid,
  listPaymentsQuerySchema,
  type ListPaymentsQuery,
  updatePaymentSchema,
  type UpdatePaymentInput,
  voidPaymentSchema,
  type VoidPaymentInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PaymentsService } from './payments.service';

/**
 * Note there is no DELETE. Payments are voided (`POST :id/void`) so the audit
 * trail survives - see the `voidedAt` comment on the Payment model.
 */
@Controller('finance/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  @RequireAbility('read', 'Payment')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listPaymentsQuerySchema)) q: ListPaymentsQuery,
  ) {
    return this.payments.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Payment')
  create(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createPaymentSchema)) input: CreatePaymentInput,
  ) {
    return this.payments.create(scope, input);
  }

  @Patch(':id')
  @RequireAbility('update', 'Payment')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updatePaymentSchema)) input: UpdatePaymentInput,
  ) {
    return this.payments.update(scope, id, input);
  }

  @Post(':id/void')
  @RequireAbility('update', 'Payment')
  void(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(voidPaymentSchema)) input: VoidPaymentInput,
  ) {
    return this.payments.void(scope, id, input);
  }
}
