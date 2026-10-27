import { forwardRef, Module } from '@nestjs/common';

import { AdminModule } from '../admin/admin.module';
import { PrismaModule } from '../prisma/prisma.module';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard';
import { OrganizationAutoRouteService } from './auto-route.service';
import { OrgMailConfigController } from './org-mail-config.controller';
import { OrgSignupController } from './org-signup.controller';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [PrismaModule, forwardRef(() => AdminModule)],
  controllers: [
    OrganizationsController,
    OrgSignupController,
    OrgMailConfigController,
  ],
  providers: [
    OrganizationsService,
    OrganizationAutoRouteService,
    GlobalAdminGuard,
    WorkspaceRoleGuard,
  ],
  exports: [
    OrganizationsService,
    OrganizationAutoRouteService,
    GlobalAdminGuard,
    WorkspaceRoleGuard,
  ],
})
export class OrganizationsModule {}
