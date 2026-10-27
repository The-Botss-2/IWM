import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { WorkspaceScopeService } from './workspace-scope.service';

@Module({
  imports: [PrismaModule],
  providers: [WorkspaceScopeService],
  exports: [WorkspaceScopeService],
})
export class ScopeModule {}
