import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { TimesheetWarningService } from './timesheet-warning.service';

/**
 * Daily timesheet-warning pass. Runs at 00:15 UTC, ten minutes after the
 * attendance cron (00:05) so the `ABSENT` rows for "yesterday" are already
 * materialised when we measure missed-day streaks.
 *
 * Like the attendance cron this only ever evaluates fully-elapsed days, so
 * an employee who logs time before the day ends is never flagged for it.
 */
@Injectable()
export class TimesheetWarningCronService {
  private readonly logger = new Logger(TimesheetWarningCronService.name);

  constructor(private readonly warnings: TimesheetWarningService) {}

  @Cron('15 0 * * *', { name: 'timesheet-warnings' })
  async run(): Promise<void> {
    try {
      await this.warnings.warnDelinquentEmployees();
    } catch (err) {
      this.logger.error(
        `Timesheet warning run failed message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }
}
