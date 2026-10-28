import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type CreateHolidayInput,
  createHolidaySchema,
  cuid,
  type ListHolidaysQuery,
  listHolidaysQuerySchema,
  type UnmarkHolidayInput,
  unmarkHolidaySchema,
  type UpdateHolidayInput,
  updateHolidaySchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { HolidaysService } from './holidays.service';

/**
 * Public holidays per organisation. List is open to any signed-in user
 * in the org (the attendance grid surfaces holidays for everyone);
 * create / update / delete are gated to ADMIN or HR.
 */
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly holidays: HolidaysService) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(listHolidaysQuerySchema))
    query: ListHolidaysQuery,
  ) {
    return this.holidays.list(user.id, query);
  }

  /**
   * Add a holiday. If `applyToAttendance` is true (default) the server
   * also stamps every existing org member's attendance row for that day
   * as HOLIDAY in one transaction. Idempotent on (organizationId, date).
   */
  @Post()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createHolidaySchema))
    input: CreateHolidayInput,
  ) {
    return this.holidays.create(user.id, input);
  }

  @Patch(':id')
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateHolidaySchema))
    input: UpdateHolidayInput,
  ) {
    return this.holidays.update(user.id, id, input);
  }

  @Delete(':id')
  @SkipPermissions()
  remove(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.holidays.remove(user.id, id);
  }

  /**
   * Re-apply an existing holiday's attendance pass. Used by the "Apply
   * to everyone again" button on the admin page — handy when HR onboards
   * a new user between adding the holiday and the date arriving.
   */
  @Post(':id/apply')
  @SkipPermissions()
  apply(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.holidays.apply(user.id, id);
  }

  /**
   * Inverse of apply: revert this holiday's attendance stamps without
   * deleting the holiday entry. `status` (from HR's chooser) forces every
   * stamped row to one outcome - CLEAR (unmark for all), PRESENT, ABSENT,
   * or LEAVE; omitting it recomputes each user's natural status.
   */
  @Post(':id/unmark')
  @SkipPermissions()
  unmark(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(unmarkHolidaySchema)) input: UnmarkHolidayInput,
  ) {
    return this.holidays.unmark(user.id, id, input.status);
  }
}
