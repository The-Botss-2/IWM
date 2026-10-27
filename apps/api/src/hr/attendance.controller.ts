import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  type AttendanceMatrixQuery,
  attendanceMatrixQuerySchema,
  type AttendanceReportQuery,
  attendanceReportQuerySchema,
  type OverrideAttendanceInput,
  overrideAttendanceSchema,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AttendanceService } from './attendance.service';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** Per-user combined Attendance + TimeEntry summary. Employees can
   *  only request their own id; HR / Admin can request any. */
  @Get('summary')
  @SkipPermissions()
  summary(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(attendanceReportQuerySchema))
    query: AttendanceReportQuery,
  ) {
    return this.attendance.summary(user.id, query);
  }

  /** Cross-user matrix grid for the HR admin page. */
  @Get('matrix')
  @SkipPermissions()
  matrix(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(attendanceMatrixQuerySchema))
    query: AttendanceMatrixQuery,
  ) {
    return this.attendance.matrix(user.id, query);
  }

  /** Active-users list for the Attendance Summary dropdown. The matrix
   *  view already shows everyone; the summary picker should too. */
  @Get('users')
  @SkipPermissions()
  listUsers(@CurrentUser() user: AuthedUser) {
    return this.attendance.listUsers(user.id);
  }

  /** HR / Admin manual override. Idempotent on (userId, date). */
  @Post('override')
  @SkipPermissions()
  override(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(overrideAttendanceSchema))
    input: OverrideAttendanceInput,
  ) {
    return this.attendance.override(user.id, input);
  }
}
