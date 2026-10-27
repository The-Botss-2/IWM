import { Controller, Get, Query } from '@nestjs/common';
import {
  type CalendarEventsQuery,
  calendarEventsQuerySchema,
} from '@botss/shared-types';

import { RequestUserScope, type UserScope } from '../common/decorators/user-scope.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { CalendarService } from './calendar.service';

@Controller('calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get('events')
  @SkipPermissions()
  listEvents(
    @RequestUserScope() scope: UserScope,
    @Query(new ZodValidationPipe(calendarEventsQuerySchema)) query: CalendarEventsQuery,
  ) {
    return this.calendar.listEvents(scope, query.from, query.to, query.types ?? []);
  }
}
