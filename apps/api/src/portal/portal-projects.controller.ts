import { Controller, Get, Param } from '@nestjs/common';
import { cuid, type PortalProjectDetail, type PortalProjectList } from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PortalProjectsService } from './portal-projects.service';

@PortalRoute()
@Controller('portal/clients/:clientId/projects')
export class PortalProjectsController {
  constructor(private readonly projects: PortalProjectsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
  ): Promise<PortalProjectList> {
    return this.projects.list(user.id, clientId);
  }

  @Get(':projectId')
  detail(
    @CurrentUser() user: AuthedUser,
    @Param('clientId', new ZodValidationPipe(cuid)) clientId: string,
    @Param('projectId', new ZodValidationPipe(cuid)) projectId: string,
  ): Promise<PortalProjectDetail> {
    return this.projects.detail(user.id, clientId, projectId);
  }
}
