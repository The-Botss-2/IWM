import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import {
  CurrentUser,
  type AuthedUser,
} from '../common/decorators/current-user.decorator';
import {
  createOrganizationSchema,
  type CreateOrganizationInput,
  type CreateOrganizationResponse,
  cuid,
  inviteOrganizationOwnerSchema,
  type InviteOrganizationOwnerInput,
  updateOrganizationSchema,
  type UpdateOrganizationInput,
} from '@botss/shared-types';

import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { GlobalAdmin, GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';

/**
 * REST controller for global-admin-only tenant management. Every route
 * is gated by `@GlobalAdmin()` + the GlobalAdminGuard so a tenant-org
 * user - even one with systemRole='ADMIN' inside their own tenant -
 * cannot reach these endpoints.
 */
@Controller('organizations')
@UseGuards(GlobalAdminGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @GlobalAdmin()
  @SkipPermissions()
  list() {
    return this.organizations.list();
  }

  @Get(':orgId')
  @GlobalAdmin()
  @SkipPermissions()
  getOne(@Param('orgId', new ZodValidationPipe(cuid)) orgId: string) {
    return this.organizations.getById(orgId);
  }

  @Post()
  @GlobalAdmin()
  @SkipPermissions()
  create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodValidationPipe(createOrganizationSchema))
    input: CreateOrganizationInput,
  ): Promise<CreateOrganizationResponse> {
    return this.organizations.create(input, user.id);
  }

  @Patch(':orgId')
  @GlobalAdmin()
  @SkipPermissions()
  update(
    @CurrentUser() user: AuthedUser,
    @Param('orgId', new ZodValidationPipe(cuid)) orgId: string,
    @Body(new ZodValidationPipe(updateOrganizationSchema))
    input: UpdateOrganizationInput,
  ) {
    return this.organizations.update(orgId, input, user.id);
  }

  @Delete(':orgId')
  @GlobalAdmin()
  @SkipPermissions()
  remove(
    @CurrentUser() user: AuthedUser,
    @Param('orgId', new ZodValidationPipe(cuid)) orgId: string,
  ) {
    return this.organizations.softDelete(orgId, user.id);
  }

  /**
   * Retroactively send a first-owner invitation to an existing tenant.
   * Use this for orgs created before the create-with-owner flow shipped,
   * or where the admin skipped the optional first-owner fields. Fails if
   * the email is already attached to a user anywhere else.
   */
  @Post(':orgId/invite-owner')
  @GlobalAdmin()
  @SkipPermissions()
  inviteOwner(
    @CurrentUser() user: AuthedUser,
    @Param('orgId', new ZodValidationPipe(cuid)) orgId: string,
    @Body(new ZodValidationPipe(inviteOrganizationOwnerSchema))
    input: InviteOrganizationOwnerInput,
  ) {
    return this.organizations.inviteFirstOwner(orgId, input, user.id);
  }

  /** Reverse an archive (soft-delete). Only valid on an archived row. */
  @Post(':orgId/restore')
  @GlobalAdmin()
  @SkipPermissions()
  restore(
    @CurrentUser() user: AuthedUser,
    @Param('orgId', new ZodValidationPipe(cuid)) orgId: string,
  ) {
    return this.organizations.restore(orgId, user.id);
  }

  /**
   * **Irreversible.** Hard-delete the tenant and cascade through every
   * dependent row. The default DELETE route does a reversible archive;
   * this separate path exists so the destructive operation has a louder
   * URL and the UI can require a stronger confirmation.
   */
  @Delete(':orgId/hard')
  @GlobalAdmin()
  @SkipPermissions()
  hardRemove(
    @CurrentUser() user: AuthedUser,
    @Param('orgId', new ZodValidationPipe(cuid)) orgId: string,
  ) {
    return this.organizations.hardDelete(orgId, user.id);
  }
}
