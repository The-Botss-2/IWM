import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  convertLeadSchema,
  type ConvertLeadInput,
  createLeadSchema,
  type CreateLeadInput,
  cuid,
  listLeadsQuerySchema,
  type ListLeadsQuery,
  updateLeadSchema,
  type UpdateLeadInput,
} from '@botss/shared-types';

import { Public } from '../common/decorators/public.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { LeadsService } from './leads.service';

/**
 * `@RequireAbility` is the coarse gate (may this user touch leads at all?);
 * `SalesActor` carries the fine one (all leads, or only theirs?). The service
 * applies the second - see LeadsService.visibilityFilter.
 */
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  @RequireAbility('read', 'Lead')
  list(
    @CurrentSalesActor() actor: SalesActor,
    @Query(new ZodValidationPipe(listLeadsQuerySchema)) q: ListLeadsQuery,
  ) {
    return this.leads.list(actor, q);
  }

  @Post()
  @RequireAbility('create', 'Lead')
  create(
    @CurrentSalesActor() actor: SalesActor,
    @Body(new ZodValidationPipe(createLeadSchema)) input: CreateLeadInput,
  ) {
    return this.leads.create(actor, input);
  }

  // Public website / chatbot lead intake — HMAC-signed (no session). Security
  // model lives in LeadsService.createFromExternalIntake. Needs the raw body to
  // verify the signature, so it takes @Req() rather than a parsed @Body().
  @Post('external')
  @Public()
  externalIntake(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-botss-signature') signature?: string,
  ) {
    return this.leads.createFromExternalIntake(req.rawBody, signature);
  }

  @Get(':id')
  @RequireAbility('read', 'Lead')
  get(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.leads.get(actor, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Lead')
  update(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateLeadSchema)) input: UpdateLeadInput,
  ) {
    return this.leads.update(actor, id, input);
  }

  @Post(':id/convert')
  @RequireAbility('update', 'Lead')
  convert(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(convertLeadSchema)) input: ConvertLeadInput,
  ) {
    return this.leads.convert(actor, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Lead')
  async remove(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.leads.remove(actor, id);
    return { ok: true };
  }
}
