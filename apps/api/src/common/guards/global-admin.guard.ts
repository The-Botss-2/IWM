import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AdminUsersService } from '../../admin/admin-users.service';
import { supportNotAllowed } from '../../support/support-rules';
import { isSupportRequest } from '../request-context';

/** Marker. Pair with the `GlobalAdminGuard` to flag a route as global-admin-only. */
export const GLOBAL_ADMIN_KEY = 'global_admin';
export const GlobalAdmin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(GLOBAL_ADMIN_KEY, true);

/**
 * Route guard for global-admin operations (cross-org tenant management,
 * org mail config, the org admin panel). Delegates to the single
 * chokepoint `AdminUsersService.assertGlobalAdmin` so the rule lives in
 * one place - see that method for the actual policy (root org + ADMIN).
 *
 * Routes opt in with `@GlobalAdmin()`; everything else is a no-op so
 * this guard can be installed globally without breaking unrelated
 * endpoints.
 */
@Injectable()
export class GlobalAdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly admin: AdminUsersService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(GLOBAL_ADMIN_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;
    const req = ctx.switchToHttp().getRequest<{ user?: { id?: string }; support?: unknown }>();
    // A read only support session is never a platform operator inside the
    // granted organization, although the operator's own user row says so.
    if (req.support || isSupportRequest()) throw supportNotAllowed();
    const userId = req.user?.id;
    if (!userId) return false;
    await this.admin.assertGlobalAdmin(userId);
    return true;
  }
}
