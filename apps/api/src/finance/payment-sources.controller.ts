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
  createPaymentSourceSchema,
  type CreatePaymentSourceInput,
  cuid,
  listPaymentSourcesQuerySchema,
  type ListPaymentSourcesQuery,
  reorderPaymentSourcesSchema,
  type ReorderPaymentSourcesInput,
  updatePaymentSourceSchema,
  type UpdatePaymentSourceInput,
} from '@botss/shared-types';

import { CurrentOrganizationId } from '../common/decorators/current-organization.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PaymentSourcesService } from './payment-sources.service';

/**
 * Organisation-scoped, not workspace-scoped: "we get paid through Upwork" is a
 * company fact, so the list is shared across every workspace in the org.
 */
@Controller('finance/payment-sources')
export class PaymentSourcesController {
  constructor(private readonly sources: PaymentSourcesService) {}

  @Get()
  @RequireAbility('read', 'PaymentSource')
  list(
    @CurrentOrganizationId() organizationId: string,
    @Query(new ZodValidationPipe(listPaymentSourcesQuerySchema))
    q: ListPaymentSourcesQuery,
  ) {
    return this.sources.list(organizationId, q);
  }

  @Post()
  @RequireAbility('create', 'PaymentSource')
  create(
    @CurrentOrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createPaymentSourceSchema))
    input: CreatePaymentSourceInput,
  ) {
    return this.sources.create(organizationId, input);
  }

  @Patch('reorder')
  @RequireAbility('update', 'PaymentSource')
  reorder(
    @CurrentOrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(reorderPaymentSourcesSchema))
    input: ReorderPaymentSourcesInput,
  ) {
    return this.sources.reorder(organizationId, input);
  }

  @Patch(':id')
  @RequireAbility('update', 'PaymentSource')
  update(
    @CurrentOrganizationId() organizationId: string,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updatePaymentSourceSchema))
    input: UpdatePaymentSourceInput,
  ) {
    return this.sources.update(organizationId, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'PaymentSource')
  remove(
    @CurrentOrganizationId() organizationId: string,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.sources.remove(organizationId, id);
  }
}
