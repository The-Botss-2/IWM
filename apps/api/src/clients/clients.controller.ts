import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createClientSchema,
  type CreateClientInput,
  cuid,
  listClientsQuerySchema,
  type ListClientsQuery,
  updateClientSchema,
  type UpdateClientInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { CurrentSalesActor, type SalesActor } from '../common/decorators/sales-actor.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ClientsService } from './clients.service';

/**
 * `@RequireAbility` is the coarse gate (may this user touch clients at all?);
 * `SalesActor` carries the fine one (all clients, or only theirs?). The service
 * applies the second - see ClientsService.visibilityFilter.
 */
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @RequireAbility('read', 'Client')
  list(
    @CurrentSalesActor() actor: SalesActor,
    @Query(new ZodValidationPipe(listClientsQuerySchema)) q: ListClientsQuery,
  ) {
    return this.clients.list(actor, q);
  }

  @Post()
  @RequireAbility('create', 'Client')
  create(
    @CurrentSalesActor() actor: SalesActor,
    @Body(new ZodValidationPipe(createClientSchema)) input: CreateClientInput,
  ) {
    return this.clients.create(actor, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Client')
  get(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.clients.get(actor, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Client')
  update(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateClientSchema)) input: UpdateClientInput,
  ) {
    return this.clients.update(actor, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Client')
  async remove(
    @CurrentSalesActor() actor: SalesActor,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.clients.remove(actor, id);
    return { ok: true };
  }
}
