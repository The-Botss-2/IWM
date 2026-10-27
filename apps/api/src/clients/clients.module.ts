import { Module } from '@nestjs/common';

import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ClientActivityController } from './client-activity.controller';
import { ClientActivityService } from './client-activity.service';
import { ClientPortalController } from './client-portal.controller';
import { ClientPortalService } from './client-portal.service';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [ClientsController, ClientPortalController, ClientActivityController],
  providers: [ClientsService, ClientPortalService, ClientActivityService],
})
export class ClientsModule {}
