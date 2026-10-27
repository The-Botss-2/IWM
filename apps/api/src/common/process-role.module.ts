import { Global, Module } from '@nestjs/common';

import { getProcessRole, PROCESS_ROLE } from './process-role';

/** Makes the process role injectable as `@Inject(PROCESS_ROLE)`. */
@Global()
@Module({
  providers: [{ provide: PROCESS_ROLE, useFactory: getProcessRole }],
  exports: [PROCESS_ROLE],
})
export class ProcessRoleModule {}
