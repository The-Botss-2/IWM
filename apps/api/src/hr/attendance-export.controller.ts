import { Controller, Get, Query, Res } from '@nestjs/common';
import {
  type ExportTimesheetQuery,
  exportTimesheetQuerySchema,
} from '@botss/shared-types';
import type { Response } from 'express';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AttendanceExportService } from './attendance-export.service';

/**
 * Mounted under `/admin/timesheets/export` to match the spec wording.
 * The service guards on (caller == target || isAdminOrHR) so the
 * "admin" path label is descriptive, not load-bearing.
 */
@Controller('admin/timesheets')
export class AttendanceExportController {
  constructor(private readonly exporter: AttendanceExportService) {}

  @Get('export')
  @SkipPermissions()
  async export(
    @CurrentUser() user: AuthedUser,
    @Query(new ZodValidationPipe(exportTimesheetQuerySchema))
    query: ExportTimesheetQuery,
    @Res() res: Response,
  ) {
    return this.exporter.streamMonthlyTimesheet(
      user.id,
      query.userId,
      query.month,
      res,
    );
  }
}
