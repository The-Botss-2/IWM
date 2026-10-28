import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

/**
 * Resolves the caller's active organization id. We trust `req.user.organizationId`
 * which the AuthGuard populates from the DB. The backfill migration ensures
 * every existing user has this set (Botss root for legacy rows), so it is
 * always present for authenticated callers; an undefined value indicates a
 * misconfigured guard chain and is a hard fail (not a silent default).
 */
export const CurrentOrganizationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<{ user?: { organizationId?: string | null } }>();
    const orgId = req.user?.organizationId ?? null;
    if (!orgId) {
      throw new InternalServerErrorException({
        title: 'Missing organization context',
        status: 500,
        detail: 'AuthGuard did not populate user.organizationId.',
      });
    }
    return orgId;
  },
);
