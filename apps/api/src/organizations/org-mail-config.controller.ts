import { Body, Controller, Get, Put } from '@nestjs/common';

import {
  upsertOrganizationMailConfigSchema,
  type UpsertOrganizationMailConfigInput,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';

/**
 * Tenant self-service mail config. Distinct from OrganizationsController (which
 * is GlobalAdminGuard-gated and addresses any org by id): this controller is
 * behind the global AuthGuard only and always operates on the CALLER's own
 * organization, which the service derives from their user row. The service
 * asserts the caller is an organization admin (systemRole ADMIN/SUPER_ADMIN),
 * so a regular org member cannot read or change the credentials.
 */
@Controller('org/mail-config')
export class OrgMailConfigController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @SkipPermissions()
  async get(@CurrentUser() user: AuthedUser) {
    const config = await this.organizations.getMailConfigForUser(user.id);
    return { config };
  }

  @Put()
  @SkipPermissions()
  upsert(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(upsertOrganizationMailConfigSchema))
    input: UpsertOrganizationMailConfigInput,
  ) {
    return this.organizations.upsertMailConfigForUser(user.id, input);
  }
}
