import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createContractSchema,
  type CreateContractInput,
  cuid,
  listContractsQuerySchema,
  type ListContractsQuery,
  updateContractSchema,
  type UpdateContractInput,
} from '@botss/shared-types';

import { RequireAbility } from '../common/decorators/required-ability.decorator';
import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { ContractsService } from './contracts.service';

/**
 * Every handler carries `@RequireAbility` - PermissionsGuard DEFAULT-ALLOWS a
 * handler without one, so a missing decorator here is an open door.
 *
 * The `Contract` subject is granted at ability Layer 0 to ADMIN / SUPER_ADMIN /
 * FINANCE and revoked at Layer 5 for everyone else, which is what stops the
 * blanket `read all` that Layer 1 hands every workspace MEMBER.
 */
@Controller('finance/contracts')
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequireAbility('read', 'Contract')
  list(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(listContractsQuerySchema)) q: ListContractsQuery,
  ) {
    return this.contracts.list(scope, q);
  }

  @Post()
  @RequireAbility('create', 'Contract')
  create(
    @RequestUserScope() scope: UserScope,
    @Body(new ZodValidationPipe(createContractSchema)) input: CreateContractInput,
  ) {
    return this.contracts.create(scope, input);
  }

  @Get(':id')
  @RequireAbility('read', 'Contract')
  get(@RequestUserScope() scope: UserScope, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.contracts.get(scope, id);
  }

  @Patch(':id')
  @RequireAbility('update', 'Contract')
  update(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateContractSchema)) input: UpdateContractInput,
  ) {
    return this.contracts.update(scope, id, input);
  }

  @Delete(':id')
  @RequireAbility('delete', 'Contract')
  async remove(
    @RequestUserScope() scope: UserScope,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    await this.contracts.remove(scope, id);
    return { ok: true };
  }
}
