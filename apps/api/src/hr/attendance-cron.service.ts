import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { AttendanceService } from './attendance.service';

/**
 * Daily attendance materialisation. Runs at 00:05 UTC each day to write
 * attendance rows for the day that just ended. Idempotent - the
 * service uses `createMany({ skipDuplicates: true })` against the
 * (userId, date) unique index, so re-running the job by hand never
 * double-stamps.
 *
 * Why 00:05 instead of 00:00:
 *   - Allows any straggler TimeEntry stop happening right at midnight
 *     local time to land in yesterday's bucket before we materialise.
 *   - Avoids overlapping with NestJS startup work on a midnight deploy.
 */
@Injectable()
export class AttendanceCronService {
  private readonly logger = new Logger(AttendanceCronService.name);

  constructor(private readonly attendance: AttendanceService) {}

  /**
   * `CronExpression.EVERY_DAY_AT_MIDNIGHT` would fire at 00:00, which
   * collides with day-boundary stop events. The explicit form here
   * targets 00:05 UTC.
   */
  @Cron('5 0 * * *', { name: 'daily-attendance' })
  async generateYesterdayAttendance(): Promise<void> {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    yesterday.setUTCHours(0, 0, 0, 0);
    try {
      await this.attendance.generateForDate(yesterday);
    } catch (err) {
      this.logger.error(
        `Daily attendance generation failed date=${yesterday.toISOString().slice(0, 10)} message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }
}
