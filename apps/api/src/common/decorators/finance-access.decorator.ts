import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { hasFinanceAccess } from '@botss/auth';

import type { RequestExtensions } from '../guards/auth.guard';
import { requestPermissions } from '../permissions/effective-permissions';

/**
 * Whether the request user holds company `finance.view` / `finance.manage`
 * (the same `hasFinanceAccess` the ability factory and SalesActor use), for
 * endpoints outside the finance module that must hide money artifacts.
 */
export const HasFinanceAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): boolean => {
    const req = ctx.switchToHttp().getRequest<RequestExtensions>();
    if (!req.user) return false;
    return hasFinanceAccess({ permissions: requestPermissions(req) });
  },
);
