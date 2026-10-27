import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  REQUIRED_ABILITY_KEY,
  type RequiredAbility,
} from '../decorators/required-ability.decorator';
import { SKIP_PERMISSIONS_KEY } from '../decorators/skip-permissions.decorator';
import { abilityForRequest } from '../permissions/request-ability';
import type { RequestExtensions } from './auth.guard';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    // Fail closed. A DI regression that drops the Reflector must surface as a
    // 403, never silently switch authorization off for every route.
    if (!this.reflector) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'Permission system unavailable.',
      });
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_PERMISSIONS_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (skip) return true;

    const required = this.reflector.getAllAndOverride<RequiredAbility>(REQUIRED_ABILITY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Without an explicit @RequireAbility, default-allow (AuthGuard already enforced login).
    // Methods that mutate data MUST declare an ability.
    if (!required) return true;

    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    if (!req.user) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'No authenticated user on request.',
      });
    }

    // Active workspace only; see abilityForRequest. NOTE: this is a
    // subject-level check. CASL answers yes when ANY rule could allow the
    // action, conditional ones included, so handlers acting on one row must
    // re-check it in the service with `abilityRow` (tasks / files / projects
    // delete do).
    const ability = abilityForRequest(req);

    if (!ability.can(required.action, required.subject)) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: `Missing ability: ${required.action} ${required.subject}`,
        code: 'insufficient_permissions',
      });
    }

    return true;
  }
}
