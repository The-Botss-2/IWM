import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { AppAbility } from '@botss/auth';

import type { RequestExtensions } from '../guards/auth.guard';
import { abilityForRequest } from '../permissions/request-ability';

/**
 * The request user's CASL ability in the active workspace, for services that
 * must check a concrete row after loading it (row-level conditions the
 * subject-only PermissionsGuard cannot see).
 */
export const RequestAbility = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AppAbility => {
    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    if (!req.user) {
      throw new ForbiddenException({
        title: 'Forbidden',
        status: 403,
        detail: 'No authenticated user on request.',
      });
    }
    return abilityForRequest(req);
  },
);
