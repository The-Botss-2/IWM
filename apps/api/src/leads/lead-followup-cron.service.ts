import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { LeadsService } from './leads.service';

/**
 * Every-minute sweep that fires a reminder notification the moment a lead's
 * follow-up time arrives. Kept coarse (minute granularity) on purpose - a
 * follow-up is a human nudge, not a real-time signal, so a sub-minute delay is
 * irrelevant and the once-per-lead guard (`followupNotifiedAt`) keeps it cheap.
 */
@Injectable()
export class LeadFollowupCronService {
  private readonly logger = new Logger(LeadFollowupCronService.name);

  constructor(private readonly leads: LeadsService) {}

  @Cron('* * * * *', { name: 'lead-followup-reminders' })
  async run(): Promise<void> {
    try {
      const fired = await this.leads.sweepDueFollowups(new Date());
      if (fired > 0) {
        this.logger.log(`Fired ${fired} lead follow-up reminder(s)`);
      }
    } catch (err) {
      this.logger.error(
        `Lead follow-up sweep failed message=${(err as Error)?.message ?? 'unknown'}`,
      );
    }
  }
}
