import { Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { ChatModule } from '../chat/chat.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceCronService } from './attendance-cron.service';
import { AttendanceExportController } from './attendance-export.controller';
import { AttendanceExportService } from './attendance-export.service';
import { AttendanceService } from './attendance.service';
import { HolidaysController } from './holidays.controller';
import { HolidaysService } from './holidays.service';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';
import { TimesheetWarningCronService } from './timesheet-warning-cron.service';
import { TimesheetWarningService } from './timesheet-warning.service';

/**
 * HR domain - Attendance + Leave + CSV export. Depends on AdminModule
 * for the `assertAdminOrHR` chokepoint and the user lookup helpers.
 *
 * The `AttendanceCronService` registers a `@Cron(...)` listener via
 * `@nestjs/schedule`; that decorator is a no-op until `ScheduleModule.forRoot()`
 * is imported once at the root (wired in app.module.ts).
 */
@Module({
  imports: [PrismaModule, AdminModule, ChatModule],
  controllers: [
    LeavesController,
    AttendanceController,
    AttendanceExportController,
    HolidaysController,
  ],
  providers: [
    LeavesService,
    AttendanceService,
    AttendanceCronService,
    AttendanceExportService,
    HolidaysService,
    TimesheetWarningService,
    TimesheetWarningCronService,
  ],
  exports: [LeavesService, AttendanceService, HolidaysService],
})
export class HrModule {}
