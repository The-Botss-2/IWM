import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  type AdminAttendanceQuery,
  adminAttendanceQuerySchema,
  type AdminTimesheetsListQuery,
  adminTimesheetsListQuerySchema,
  type CreateTimeEntryInput,
  createTimeEntrySchema,
  cuid,
  type ListTimesheetsQuery,
  listTimesheetsQuerySchema,
  type StartTimerInput,
  startTimerSchema,
  type TimesheetSummaryQuery,
  timesheetSummaryQuerySchema,
  type UpdateTimeEntryInput,
  updateTimeEntrySchema,
} from '@botss/shared-types';

import { AdminUsersService } from '../admin/admin-users.service';
import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { CurrentWorkspaceId } from '../common/decorators/current-workspace.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TimesheetsService } from './timesheets.service';

@Controller('timesheets')
export class TimesheetsController {
  constructor(
    private readonly timesheets: TimesheetsService,
    private readonly admin: AdminUsersService,
  ) {}

  @Get()
  @SkipPermissions()
  list(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Query(new ZodValidationPipe(listTimesheetsQuerySchema)) query: ListTimesheetsQuery,
  ) {
    return this.timesheets.list(user.id, workspaceId, query);
  }

  @Get('summary')
  @SkipPermissions()
  summary(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Query(new ZodValidationPipe(timesheetSummaryQuerySchema)) query: TimesheetSummaryQuery,
  ) {
    return this.timesheets.summary(user.id, workspaceId, query.from, query.to, query.userId);
  }

  @Post('start')
  @SkipPermissions()
  startTimer(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(startTimerSchema)) input: StartTimerInput,
  ) {
    return this.timesheets.startTimer(user.id, workspaceId, input);
  }

  @Post('stop/:id')
  @SkipPermissions()
  stopTimer(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.timesheets.stopTimer(user.id, id);
  }

  /**
   * Pause a running timer. Returns the updated row with `pausedAt`
   * stamped. 409 if the timer is already paused (per spec).
   */
  @Post('pause/:id')
  @SkipPermissions()
  pauseTimer(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.timesheets.pauseTimer(user.id, id);
  }

  /**
   * Resume a paused timer. Folds the just-closed pause window into
   * `accumulatedPauseMin` and clears `pausedAt`. 400 if the timer is
   * already running or already stopped.
   */
  @Post('resume/:id')
  @SkipPermissions()
  resumeTimer(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
  ) {
    return this.timesheets.resumeTimer(user.id, id);
  }

  @Post()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Body(new ZodValidationPipe(createTimeEntrySchema)) input: CreateTimeEntryInput,
  ) {
    return this.timesheets.create(user.id, workspaceId, input);
  }

  @Patch(':id')
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @CurrentWorkspaceId() workspaceId: string,
    @Param('id', new ZodValidationPipe(cuid)) id: string,
    @Body(new ZodValidationPipe(updateTimeEntrySchema)) input: UpdateTimeEntryInput,
  ) {
    return this.timesheets.update(user.id, workspaceId, id, input);
  }

  @Delete(':id')
  @SkipPermissions()
  remove(@CurrentUser() user: AuthedUser, @Param('id', new ZodValidationPipe(cuid)) id: string) {
    return this.timesheets.remove(user.id, id);
  }

  // ---------------------------------------------------------------------------
  // Admin - cross-workspace, cross-user. The raw list stays system-admin only;
  // the attendance read also admits HR (the /admin/timesheets page is gated to
  // ADMIN/HR/SUPER_ADMIN, and HR owns timesheet management). Both stay
  // org-scoped in the service - HR sees only their own org's entries.
  // ---------------------------------------------------------------------------

  @Get('admin/list')
  @SkipPermissions()
  async adminList(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(adminTimesheetsListQuerySchema))
    query: AdminTimesheetsListQuery,
  ) {
    await this.admin.assertAdmin(user.id);
    return this.timesheets.adminList(user.id, query);
  }

  @Get('admin/attendance')
  @SkipPermissions()
  async adminAttendance(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(adminAttendanceQuerySchema))
    query: AdminAttendanceQuery,
  ) {
    await this.admin.assertAdminOrHR(user.id);
    return this.timesheets.adminAttendance(user.id, query.from, query.to);
  }
}
