import { Module } from '@nestjs/common';

import { LeadFollowupCronService } from './lead-followup-cron.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  controllers: [LeadsController],
  providers: [LeadsService, LeadFollowupCronService],
})
export class LeadsModule {}
