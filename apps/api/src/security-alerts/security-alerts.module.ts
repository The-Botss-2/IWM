import { Global, Module } from '@nestjs/common';

import { SecurityAlertsService } from './security-alerts.service';

/** Global so feature services can inject it as an optional dependency. */
@Global()
@Module({
  providers: [SecurityAlertsService],
  exports: [SecurityAlertsService],
})
export class SecurityAlertsModule {}
