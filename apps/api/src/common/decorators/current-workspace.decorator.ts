import { createParamDecorator, type ExecutionContext, ForbiddenException } from '@nestjs/common';

/** Returns the currently active workspaceId resolved by AuthGuard, or 403s if missing. */
export const CurrentWorkspaceId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<{ workspaceId?: string | null }>();
    if (!req.workspaceId) {
      throw new ForbiddenException({
        title: 'No active workspace',
        status: 403,
        detail: 'The current user has no workspace membership and cannot access this resource.',
      });
    }
    return req.workspaceId;
  },
);
