import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  portalChangePasswordSchema,
  portalOkSchema,
  type PortalChangePasswordInput,
  type PortalMe,
  type PortalOk,
} from '@botss/shared-types';

import { CurrentUser, type AuthedUser } from '../common/decorators/current-user.decorator';
import { PortalRoute } from '../common/decorators/portal-route.decorator';
import type { RequestExtensions } from '../common/guards/auth.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { PortalService } from './portal.service';

/**
 * The signed-in client person. Every portal controller is `@PortalRoute()`
 * at class level: CLIENT accounts only, and never CASL - authorization is
 * `PortalScopeService`.
 */
@PortalRoute()
@Controller('portal/me')
export class PortalMeController {
  constructor(private readonly portal: PortalService) {}

  @Get()
  me(@CurrentUser() user: AuthedUser): Promise<PortalMe> {
    return this.portal.me(user);
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: AuthedUser,
    @Req() req: RequestExtensions,
    @Body(new ZodValidationPipe(portalChangePasswordSchema)) body: PortalChangePasswordInput,
  ): Promise<PortalOk> {
    await this.portal.changePassword(user, req.sessionId, body);
    return portalOkSchema.parse({ ok: true });
  }
}
