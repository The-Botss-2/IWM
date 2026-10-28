import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { WorkspaceRole } from '@botss/database';

import { PrismaService } from '../../prisma/prisma.service';
import { orgWorkspaceMembership } from '../tenant-scope';

export const REQUIRE_WORKSPACE_ROLE_KEY = 'require_workspace_role';

/**
 * `@RequireWorkspaceRole('OWNER', 'ADMIN')` - gates a route on the
 * caller's WorkspaceMembership.role for the active workspace. The active
 * workspace is read from the `x-workspace-id` header (same as the
 * existing CurrentWorkspaceId decorator) so we don't need a separate
 * resolver here.
 */
/** @public Decorator paired with WorkspaceRoleGuard; no route uses it yet. */
export const RequireWorkspaceRole = (...roles: WorkspaceRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRE_WORKSPACE_ROLE_KEY, roles);

@Injectable()
export class WorkspaceRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<WorkspaceRole[]>(REQUIRE_WORKSPACE_ROLE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<{
      user?: { id?: string };
      headers: Record<string, string>;
      workspaceMemberships?: Array<{ workspaceId: string; role: string }>;
    }>();
    const userId = req.user?.id;
    const workspaceId = (req.headers['x-workspace-id'] as string | undefined) ?? null;
    if (!userId || !workspaceId) {
      throw new ForbiddenException({
        title: 'Missing workspace context',
        status: 403,
      });
    }
    // AuthGuard already loaded this user's memberships. Its list drops
    // memberships of deleted / other-org workspaces; a miss falls back to the
    // database for deleted workspaces (restore flows) but only inside the
    // user's own organization, so a stale other-org membership never counts.
    const known = req.workspaceMemberships?.find((m) => m.workspaceId === workspaceId);
    const membership = known ?? (await orgWorkspaceMembership(this.prisma, userId, workspaceId));
    if (!membership || !required.includes(membership.role as WorkspaceRole)) {
      throw new ForbiddenException({
        title: 'Insufficient workspace role',
        status: 403,
        detail: `Requires one of: ${required.join(', ')}.`,
      });
    }
    return true;
  }
}
