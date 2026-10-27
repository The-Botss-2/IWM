import { Module } from '@nestjs/common';

import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProjectPortalController } from './project-portal.controller';
import { ProjectPortalService } from './project-portal.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [WorkspacesModule],
  controllers: [ProjectsController, ProjectPortalController],
  providers: [ProjectsService, ProjectPortalService],
})
export class ProjectsModule {}
