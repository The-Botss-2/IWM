import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  createSupportGrantSchema,
  cuid,
  startSupportSessionSchema,
  type ActiveSupportGrantListResponse,
  type CreateSupportGrantInput,
  type StartSupportSessionInput,
  type SupportGrant,
  type SupportGrantListResponse,
  type SupportSession,
} from '@botss/shared-types';

import { CurrentOrganizationId } from '../common/decorators/current-organization.decorator';
import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { SkipPermissions } from '../common/decorators/skip-permissions.decorator';
import { GlobalAdmin, GlobalAdminGuard } from '../common/guards/global-admin.guard';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SupportService } from './support.service';

/**
 * Support access.
 *
 * - `/support/grants*`: the caller's own organization's grants. Company
 *   `org.settings` is checked in the service (`@SkipPermissions` because the
 *   rule is a company permission, not a CASL subject).
 * - `/support/active-grants`, `/support/sessions`: platform operators only
 *   (`@GlobalAdmin`, and the service re-checks the root organization).
 *
 * Every response is parsed with its shared-types schema in the service.
 */
@Controller('support')
@UseGuards(GlobalAdminGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('grants')
  @SkipPermissions()
  listGrants(
    @CurrentUser() user: AuthedUser,
    @CurrentOrganizationId() organizationId: string,
  ): Promise<SupportGrantListResponse> {
    return this.support.listGrants(user.id, organizationId);
  }

  @Post('grants')
  @SkipPermissions()
  createGrant(
    @CurrentUser() user: AuthedUser,
    @CurrentOrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createSupportGrantSchema)) input: CreateSupportGrantInput,
  ): Promise<SupportGrant> {
    return this.support.createGrant(user.id, organizationId, input);
  }

  @Post('grants/:grantId/revoke')
  @SkipPermissions()
  revokeGrant(
    @CurrentUser() user: AuthedUser,
    @CurrentOrganizationId() organizationId: string,
    @Param('grantId', new ZodValidationPipe(cuid)) grantId: string,
  ): Promise<SupportGrant> {
    return this.support.revokeGrant(user.id, organizationId, grantId);
  }

  @Get('active-grants')
  @GlobalAdmin()
  @SkipPermissions()
  listActive(@CurrentUser() user: AuthedUser): Promise<ActiveSupportGrantListResponse> {
    return this.support.listActive(user.id);
  }

  @Post('sessions')
  @GlobalAdmin()
  @SkipPermissions()
  startSession(
    @CurrentUser() user: AuthedUser,
    @Req() req: RequestExtensions,
    @Body(new ZodValidationPipe(startSupportSessionSchema)) input: StartSupportSessionInput,
  ): Promise<SupportSession> {
    return this.support.startSession(user.id, req.sessionId, input.grantId);
  }
}
