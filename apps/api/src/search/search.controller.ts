import { Controller, Get, Query } from '@nestjs/common';
import { searchQuerySchema, type SearchQuery } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { RequireAbility } from '../common/decorators/required-ability.decorator';
import {
  CurrentSalesActor,
  type SalesActor,
} from '../common/decorators/sales-actor.decorator';
import {
  RequestUserScope,
  type UserScope,
} from '../common/decorators/user-scope.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @RequireAbility('read', 'Workspace')
  query(
    // Chat hits are organization-wide; the org comes from the session, never
    // from the request.
    @CurrentUser() user: AuthedUser | undefined,
    @RequestUserScope() scope: UserScope,
    // Lead/client hits obey the same assignee scoping as the Leads and Clients
    // pages, so search can't be used to enumerate the pipeline sideways.
    @CurrentSalesActor() salesActor: SalesActor,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: SearchQuery,
  ) {
    return this.search.search(scope, salesActor, user?.organizationId ?? null, query);
  }
}
