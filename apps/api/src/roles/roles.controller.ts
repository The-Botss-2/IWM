import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  createRoleSchema,
  listRolesResponseSchema,
  permissionCatalogResponseSchema,
  roleSchema,
  rolesOkResponseSchema,
  setCompanyRoleSchema,
  setPermissionOverridesSchema,
  updateRoleSchema,
  userPermissionsQuerySchema,
  userPermissionsResponseSchema,
  type CreateRoleInput,
  type SetCompanyRoleInput,
  type SetPermissionOverridesInput,
  type UpdateRoleInput,
  type UserPermissionsQuery,
} from '@botss/shared-types';

import type { RequestExtensions } from '../common/guards/auth.guard';
import { requestPermissions } from '../common/permissions/effective-permissions';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RolesService, type RolesActor } from './roles.service';

/**
 * Configurable roles & permissions. No `@RequireAbility`: the service checks
 * `roles.manage` (company) or `members.manage` (active workspace) itself,
 * because the guardrails depend on WHICH permissions are being handed out.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('catalog')
  catalog() {
    return permissionCatalogResponseSchema.parse(this.roles.catalog());
  }

  @Get()
  async list(@Req() req: RequestExtensions) {
    return listRolesResponseSchema.parse(await this.roles.list(actorOf(req)));
  }

  @Post()
  async create(
    @Req() req: RequestExtensions,
    @Body(new ZodValidationPipe(createRoleSchema)) input: CreateRoleInput,
  ) {
    return roleSchema.parse(await this.roles.create(actorOf(req), input));
  }

  @Patch(':id')
  async update(
    @Req() req: RequestExtensions,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateRoleSchema)) input: UpdateRoleInput,
  ) {
    return roleSchema.parse(await this.roles.update(actorOf(req), id, input));
  }

  @Delete(':id')
  @HttpCode(200)
  async remove(@Req() req: RequestExtensions, @Param('id') id: string) {
    await this.roles.remove(actorOf(req), id);
    return rolesOkResponseSchema.parse({ ok: true });
  }

  @Get('users/:userId')
  async userPermissions(
    @Req() req: RequestExtensions,
    @Param('userId') userId: string,
    @Query(new ZodValidationPipe(userPermissionsQuerySchema)) query: UserPermissionsQuery,
  ) {
    return userPermissionsResponseSchema.parse(
      await this.roles.getUserPermissions(actorOf(req), userId, query.workspaceId),
    );
  }

  @Put('users/:userId/company-role')
  async setCompanyRole(
    @Req() req: RequestExtensions,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(setCompanyRoleSchema)) input: SetCompanyRoleInput,
  ) {
    return userPermissionsResponseSchema.parse(
      await this.roles.setCompanyRole(actorOf(req), userId, input),
    );
  }

  @Put('users/:userId/overrides')
  async setOverrides(
    @Req() req: RequestExtensions,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(setPermissionOverridesSchema)) input: SetPermissionOverridesInput,
  ) {
    return userPermissionsResponseSchema.parse(
      await this.roles.setOverrides(actorOf(req), userId, input),
    );
  }
}

function actorOf(req: RequestExtensions): RolesActor {
  return {
    userId: req.user?.id ?? '',
    organizationId: req.user?.organizationId ?? null,
    activeWorkspaceId: req.workspaceId ?? null,
    permissions: requestPermissions(req),
  };
}
