import { Global, Module } from '@nestjs/common';

import { CpanelService } from './cpanel.service';

/**
 * cPanel UAPI integration. Marked @Global so any service can inject the
 * client without explicit module wiring - used by AdminUsersService today,
 * future automation hooks tomorrow.
 */
@Global()
@Module({
  providers: [CpanelService],
  exports: [CpanelService],
})
export class CpanelModule {}
